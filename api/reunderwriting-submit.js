// POST /api/reunderwriting-submit
//   Body: {
//     due_id: <number>,
//     thesis_still_valid: <text>,
//     kill_criteria_concern: <text|null>,
//     action: 'buy_more'|'hold'|'trim'|'sell',
//     action_reason: <text|null>,
//     price_at_review: <number|null>,
//     outcome: 'thesis_intact'|'thresholds_recalibrated'|'thesis_evolved'|'thesis_broken',
//     change_summary: <text|null>,           // required if outcome != thesis_intact
//     new_thesis_summary: <text|null>,       // optional, for thesis_evolved
//     new_failure_modes: <array|null>,       // optional, full replacement for failure modes (rare)
//     quarterly_metrics: [                   // optional, observations for quarterly_metric failure modes
//       { failure_mode_id, observed_value, notes? }
//     ]
//   }
//
// Behavior:
//   1. Validates due exists + still pending, validates outcome
//   2. Snapshots current failure_modes for the ticker
//   3. Inserts row in reunderwriting_entries
//   4. If outcome != 'thesis_intact', creates premortem_revisions row with snapshot of CURRENT
//      thesis_summary + failure_modes (= the version being closed) and bumps premortems.version
//   5. Marks due as 'done' with outcome + outcome_notes + revision_id
//   6. If outcome == 'thesis_broken', sends Slack + email alert (no auto-sell)
//   7. Returns { ok, entry_id, due_id, revision_id, outcome, alert }
//
// Auth: admin only (re-underwriting is a CIO decision, not analyst).

'use strict';

const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');
const { sendThesisBrokenAlert } = require('./_notify');

const VALID_ACTIONS = new Set(['buy_more', 'hold', 'trim', 'sell']);
const VALID_OUTCOMES = new Set(['thesis_intact', 'thresholds_recalibrated', 'thesis_evolved', 'thesis_broken']);

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const body = await readJsonBody(req);
    const dueId = Number(body.due_id);
    const thesisText = String(body.thesis_still_valid || '').trim();
    const action = String(body.action || '').trim();
    const killConcern = body.kill_criteria_concern ? String(body.kill_criteria_concern).trim() : null;
    const actionReason = body.action_reason ? String(body.action_reason).trim() : null;
    const priceAtReview = body.price_at_review != null ? Number(body.price_at_review) : null;
    const outcome = String(body.outcome || '').trim();
    const changeSummary = body.change_summary ? String(body.change_summary).trim() : null;
    const newThesisSummary = body.new_thesis_summary ? String(body.new_thesis_summary).trim() : null;
    const newFailureModes = Array.isArray(body.new_failure_modes) ? body.new_failure_modes : null;
    const quarterlyMetricsInput = Array.isArray(body.quarterly_metrics) ? body.quarterly_metrics : [];

    // Basic validation
    if (!dueId) return res.status(400).end(JSON.stringify({ ok: false, error: 'due_id required' }));
    if (!thesisText || thesisText.length < 10) {
      return res.status(400).end(JSON.stringify({ ok: false, error: 'thesis_still_valid required (min 10 chars)' }));
    }
    if (!VALID_ACTIONS.has(action)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: `action must be one of: ${Array.from(VALID_ACTIONS).join(', ')}` }));
    }
    if (!VALID_OUTCOMES.has(outcome)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: `outcome must be one of: ${Array.from(VALID_OUTCOMES).join(', ')}` }));
    }
    if (outcome !== 'thesis_intact' && (!changeSummary || changeSummary.length < 10)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: 'change_summary required (min 10 chars) when outcome != thesis_intact' }));
    }
    if (outcome === 'thesis_broken' && action !== 'sell' && action !== 'trim') {
      // Friendly warning, not blocking — committee may need a meeting before selling
      // (we still allow 'hold' but flag it in notes)
    }

    // 1. Validate due row
    const dues = await sbSelect('reunderwriting_due', `select=*&id=eq.${dueId}&limit=1`);
    if (dues.length === 0) return res.status(404).end(JSON.stringify({ ok: false, error: 'due_id not found' }));
    const due = dues[0];
    if (due.status !== 'pending') {
      return res.status(409).end(JSON.stringify({ ok: false, error: `due is already ${due.status}` }));
    }

    // 2. Load active premortem for this ticker (single source of truth)
    const pms = await sbSelect('premortems', `select=id,thesis_summary,version,current_revision_id&ticker=eq.${due.ticker}&status=eq.active&limit=1`);
    const pm = pms[0] || null;

    // Snapshot current failure modes for the ticker
    let killSnapshot = [];
    if (pm) {
      killSnapshot = await sbSelect(
        'failure_modes',
        `select=id,failure_mode,category,trigger_type,trigger_config,probability_pct,severity_pct,status,triggered_at&premortem_id=eq.${pm.id}&order=id.asc`
      );
    }

    // 2b. Process quarterly_metric observations (if any)
    // Build a snapshot to embed in the entry, evaluate triggered/monitoring per metric
    // and persist trigger_evaluations + failure_modes status updates.
    const evaluatedAt = new Date().toISOString();
    const quarterlyMetricsSnapshot = [];
    if (quarterlyMetricsInput.length > 0) {
      // Load the failure modes referenced (must belong to the same ticker's active premortem and be quarterly_metric)
      const ids = quarterlyMetricsInput.map(q => Number(q.failure_mode_id)).filter(Boolean);
      if (ids.length > 0) {
        const fms = await sbSelect(
          'failure_modes',
          `select=id,premortem_id,failure_mode,trigger_type,trigger_config,probability_pct,severity_pct,status&id=in.(${ids.join(',')})`
        );
        // For consecutive-quarter logic, fetch last 4 evaluations per failure_mode_id
        const evalsByFm = new Map();
        if (fms.length > 0) {
          const histRows = await sbSelect(
            'trigger_evaluations',
            `select=failure_mode_id,evaluated_at,status,observed_value&failure_mode_id=in.(${fms.map(f => f.id).join(',')})&order=evaluated_at.desc&limit=200`
          );
          for (const row of histRows) {
            if (!evalsByFm.has(row.failure_mode_id)) evalsByFm.set(row.failure_mode_id, []);
            evalsByFm.get(row.failure_mode_id).push(row);
          }
        }

        for (const input of quarterlyMetricsInput) {
          const fmId = Number(input.failure_mode_id);
          const fm = fms.find(f => f.id === fmId);
          if (!fm) continue;
          if (fm.trigger_type !== 'quarterly_metric') continue;
          // Validate fm belongs to the ticker's active premortem
          if (pm && fm.premortem_id !== pm.id) continue;
          // Allow null observed_value with notes='N/A this quarter' to skip threshold eval
          const observedRaw = input.observed_value;
          const isNA = observedRaw == null || observedRaw === '';
          const observed = isNA ? null : Number(observedRaw);
          if (!isNA && Number.isNaN(observed)) continue;

          const cfg = fm.trigger_config || {};
          const operator = cfg.operator || '<';
          const threshold = cfg.threshold_pct != null ? Number(cfg.threshold_pct) : null;
          const consecutive = Math.max(1, Number(cfg.consecutive_quarters || 1));

          let newStatus = fm.status; // by default keep prior status if N/A
          let evidence;
          if (isNA) {
            evidence = `${fm.failure_mode}: N/A this quarter${input.notes ? ` (${String(input.notes).slice(0, 200)})` : ''}.`;
          } else if (threshold == null) {
            // No threshold defined; treat as monitoring with the observation
            newStatus = 'monitoring';
            evidence = `${fm.failure_mode}: observed ${observed}; no threshold_pct configured.`;
          } else {
            // Compare current observation
            const currViolates = compareViolates(observed, operator, threshold);
            if (consecutive <= 1) {
              newStatus = currViolates ? 'triggered' : 'monitoring';
            } else {
              // Look back at consecutive-1 most recent prior obs (status=='triggered' OR observed value violating)
              const hist = (evalsByFm.get(fm.id) || []).filter(r => r.observed_value != null);
              let streak = currViolates ? 1 : 0;
              if (currViolates) {
                for (let i = 0; i < hist.length && streak < consecutive; i++) {
                  const v = Number(hist[i].observed_value);
                  if (compareViolates(v, operator, threshold)) streak++;
                  else break;
                }
              }
              newStatus = streak >= consecutive ? 'triggered' : 'monitoring';
            }
            evidence = `${fm.failure_mode}: observed ${observed} ${operator} ${threshold} \u2192 ${newStatus}${consecutive > 1 ? ` (consecutive_quarters=${consecutive})` : ''}.`;
          }

          const evalRow = {
            failure_mode_id: fm.id,
            evaluated_at: evaluatedAt,
            status: newStatus,
            observed_value: isNA ? null : observed,
            threshold_value: threshold,
            evidence_text: evidence,
            notes: input.notes ? String(input.notes).slice(0, 500) : null,
          };
          await sbInsert('trigger_evaluations', evalRow);

          const patch = { last_evaluated_at: evaluatedAt };
          if (newStatus !== fm.status) {
            patch.status = newStatus;
            if (newStatus === 'triggered' && !fm.triggered_at) patch.triggered_at = evaluatedAt;
          }
          await sbUpdate('failure_modes', `id=eq.${fm.id}`, patch);

          quarterlyMetricsSnapshot.push({
            failure_mode_id: fm.id,
            failure_mode: fm.failure_mode,
            metric: cfg.metric || null,
            observed_value: isNA ? null : observed,
            threshold_value: threshold,
            operator,
            consecutive_quarters: consecutive,
            new_status: newStatus,
            prior_status: fm.status,
            na_this_quarter: isNA,
            notes: input.notes || null,
            evaluated_at: evaluatedAt,
          });
        }
      }
    }

    // 3. Insert reunderwriting_entries
    const inserted = await sbInsert('reunderwriting_entries', [{
      due_id: due.id,
      ticker: due.ticker,
      period_end: due.period_end,
      thesis_still_valid: thesisText,
      kill_criteria_snapshot: killSnapshot,
      kill_criteria_concern: killConcern,
      quarterly_metrics_snapshot: quarterlyMetricsSnapshot.length > 0 ? quarterlyMetricsSnapshot : null,
      action,
      action_reason: actionReason,
      price_at_review: priceAtReview,
      reviewer_email: auth.user.email,
    }]);
    const entry = Array.isArray(inserted) ? inserted[0] : inserted;

    // 4. If outcome triggers a revision, create premortem_revisions row
    let revisionId = null;
    let newVersion = null;
    if (outcome !== 'thesis_intact' && pm) {
      const nextVersion = (pm.version || 1) + 1;
      const changeType = outcome; // direct mapping (DB CHECK aligns)
      // Snapshot is of the NEW state (after committee decision):
      //   - thresholds_recalibrated / thesis_evolved: keep new thesis_summary + new failure modes
      //   - thesis_broken: snapshot the broken contract for audit (we don't change failure modes)
      const finalThesis = newThesisSummary || pm.thesis_summary;
      const finalFailureModes = newFailureModes || killSnapshot;

      const revInserted = await sbInsert('premortem_revisions', [{
        premortem_id: pm.id,
        version_num: nextVersion,
        thesis_summary: finalThesis,
        failure_modes_snapshot: finalFailureModes,
        change_type: changeType,
        change_summary: changeSummary,
        reunderwriting_due_id: due.id,
        ratified_by_committee: true,
        created_by: auth.user.email,
      }]);
      const rev = Array.isArray(revInserted) ? revInserted[0] : revInserted;
      revisionId = rev.id;
      newVersion = nextVersion;

      // If thesis_evolved or thresholds_recalibrated: update the active premortem to point at new revision
      // If thesis_broken: bump version too (the broken contract is a new closed chapter)
      const pmUpdate = {
        version: nextVersion,
        current_revision_id: revisionId,
        updated_at: new Date().toISOString(),
      };
      if (newThesisSummary) pmUpdate.thesis_summary = newThesisSummary;
      await sbUpdate('premortems', `id=eq.${pm.id}`, pmUpdate);
    }

    // 5. Mark due as done with outcome
    await sbUpdate('reunderwriting_due', `id=eq.${due.id}`, {
      status: 'done',
      completed_at: new Date().toISOString(),
      entry_id: entry.id,
      outcome,
      outcome_notes: changeSummary,
      revision_id: revisionId,
    });

    // 6. Alert on thesis_broken (no auto-sell)
    let alert = null;
    if (outcome === 'thesis_broken') {
      try {
        alert = await sendThesisBrokenAlert({
          ticker: due.ticker,
          period_end: due.period_end,
          doc_type: due.doc_type,
          thesis_summary_old: pm ? pm.thesis_summary : null,
          change_summary: changeSummary,
          reviewer_email: auth.user.email,
          due_id: due.id,
          revision_id: revisionId,
        });
      } catch (e) {
        alert = { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      entry_id: entry.id,
      due_id: due.id,
      ticker: due.ticker,
      period_end: due.period_end,
      action,
      outcome,
      revision_id: revisionId,
      new_version: newVersion,
      alert,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

function compareViolates(observed, operator, threshold) {
  const o = Number(observed);
  const t = Number(threshold);
  if (Number.isNaN(o) || Number.isNaN(t)) return false;
  switch (operator) {
    case '<':  return o <  t;
    case '<=': return o <= t;
    case '>':  return o >  t;
    case '>=': return o >= t;
    case '==':
    case '=':  return o === t;
    case '!=': return o !== t;
    default:   return o < t; // safe default
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
