// GET /api/premortem-history?ticker=MSFT
//   Returns the full version history of the premortem for a ticker.
//   Each item: version_num, change_type, change_summary, thesis_summary,
//   failure_modes_snapshot, due_id, created_at, created_by, plus a `diff_vs_prior`
//   field summarizing what changed compared to the immediate previous version.
//
// Auth: any active user.

'use strict';

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
    if (!ticker) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'ticker required' }));
      return;
    }

    // Find active premortem for this ticker
    const pms = await sbSelect('premortems', `select=id,ticker,version,thesis_summary,current_revision_id,created_at&ticker=eq.${ticker}&status=eq.active&limit=1`);
    if (pms.length === 0) {
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, ticker, premortem: null, revisions: [] }));
      return;
    }
    const pm = pms[0];

    // Pull all revisions ordered ascending
    const revisions = await sbSelect(
      'premortem_revisions',
      `select=id,version_num,thesis_summary,failure_modes_snapshot,change_type,change_summary,reunderwriting_due_id,ratified_by_committee,created_at,created_by&premortem_id=eq.${pm.id}&order=version_num.asc`
    );

    // Compute diff vs prior version for each revision
    const enriched = revisions.map((rev, idx) => {
      const prior = idx > 0 ? revisions[idx - 1] : null;
      const diff = computeDiff(prior, rev);
      return { ...rev, diff_vs_prior: diff };
    });

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      ticker,
      premortem: { id: pm.id, version: pm.version, current_revision_id: pm.current_revision_id, thesis_summary: pm.thesis_summary },
      revisions: enriched,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

function computeDiff(prior, current) {
  if (!prior) {
    return { thesis_changed: false, failure_modes: { added: [], removed: [], modified: [] }, summary: 'Initial revision' };
  }
  const thesisChanged = (prior.thesis_summary || '') !== (current.thesis_summary || '');

  const priorMap = {};
  for (const fm of prior.failure_modes_snapshot || []) priorMap[fm.failure_mode || fm.id] = fm;
  const currMap = {};
  for (const fm of current.failure_modes_snapshot || []) currMap[fm.failure_mode || fm.id] = fm;

  const added = [];
  const removed = [];
  const modified = [];

  for (const k of Object.keys(currMap)) {
    if (!(k in priorMap)) {
      added.push({ failure_mode: currMap[k].failure_mode, category: currMap[k].category });
    } else {
      // Compare scalar fields
      const a = priorMap[k];
      const b = currMap[k];
      const changes = {};
      ['probability_pct', 'severity_pct', 'status', 'category'].forEach(f => {
        if (a[f] !== b[f]) changes[f] = { from: a[f], to: b[f] };
      });
      if (JSON.stringify(a.trigger_config || {}) !== JSON.stringify(b.trigger_config || {})) {
        changes.trigger_config = { from: a.trigger_config, to: b.trigger_config };
      }
      if (Object.keys(changes).length > 0) {
        modified.push({ failure_mode: b.failure_mode, changes });
      }
    }
  }
  for (const k of Object.keys(priorMap)) {
    if (!(k in currMap)) removed.push({ failure_mode: priorMap[k].failure_mode, category: priorMap[k].category });
  }

  let summary = [];
  if (thesisChanged) summary.push('Thesis text changed');
  if (added.length) summary.push(`${added.length} failure mode(s) added`);
  if (removed.length) summary.push(`${removed.length} removed`);
  if (modified.length) summary.push(`${modified.length} modified`);
  if (summary.length === 0) summary.push('No structural changes');

  return {
    thesis_changed: thesisChanged,
    failure_modes: { added, removed, modified },
    summary: summary.join(' · '),
  };
}
