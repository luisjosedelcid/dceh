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
//     new_failure_modes: <array|null>        // optional, full replacement for failure modes (rare)
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

    // 3. Insert reunderwriting_entries
    const inserted = await sbInsert('reunderwriting_entries', [{
      due_id: due.id,
      ticker: due.ticker,
      period_end: due.period_end,
      thesis_still_valid: thesisText,
      kill_criteria_snapshot: killSnapshot,
      kill_criteria_concern: killConcern,
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
