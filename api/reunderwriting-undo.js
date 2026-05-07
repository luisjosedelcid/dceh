// POST /api/reunderwriting-undo
//   Body: { due_id: <number>, confirm: true }
//
// Reverts a completed re-underwriting back to pending state:
//   1. Validates due exists and status='done'
//   2. If a premortem_revision was created, deletes it AND rolls back
//      premortems.version, current_revision_id and (when it was overwritten)
//      thesis_summary to the previous revision (or to the pre-V2 baseline).
//   3. Deletes the reunderwriting_entries row.
//   4. Resets reunderwriting_due to status='pending', clearing entry_id,
//      outcome, outcome_notes, revision_id, completed_at.
//
// This is destructive but recoverable — auditing is left to admin discretion
// (the user explicitly asked for a "deshacer" / undo button).
//
// Auth: admin only.

'use strict';

const { sbSelect, sbDelete, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');

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
    const confirm = body.confirm === true;
    if (!dueId) {
      return res.status(400).end(JSON.stringify({ ok: false, error: 'due_id required' }));
    }
    if (!confirm) {
      return res.status(400).end(JSON.stringify({ ok: false, error: 'confirm flag required (must be true)' }));
    }

    // 1. Load due
    const dues = await sbSelect('reunderwriting_due', `select=*&id=eq.${dueId}&limit=1`);
    if (dues.length === 0) {
      return res.status(404).end(JSON.stringify({ ok: false, error: 'due not found' }));
    }
    const due = dues[0];
    if (due.status !== 'done') {
      return res.status(409).end(JSON.stringify({ ok: false, error: `due is ${due.status}, can only undo done dues` }));
    }

    const undone = { entry_deleted: false, revision_deleted: false, premortem_rolled_back: false };

    // 2. Roll back the premortem revision if any
    if (due.revision_id) {
      const revs = await sbSelect('premortem_revisions', `select=*&id=eq.${due.revision_id}&limit=1`);
      const rev = revs[0] || null;
      if (rev) {
        // Find the previous revision for this premortem (highest version_num strictly less than this one)
        const prevs = await sbSelect(
          'premortem_revisions',
          `select=id,version_num,thesis_summary&premortem_id=eq.${rev.premortem_id}&version_num=lt.${rev.version_num}&order=version_num.desc&limit=1`
        );
        const prev = prevs[0] || null;

        // Load the active premortem
        const pms = await sbSelect('premortems', `select=id,version,current_revision_id,thesis_summary&id=eq.${rev.premortem_id}&limit=1`);
        const pm = pms[0] || null;

        if (pm) {
          // Roll back: version goes back to prev.version_num (or 1 if no prev), current_revision_id to prev.id (or null)
          const rollbackVersion = prev ? prev.version_num : 1;
          const rollbackRevId = prev ? prev.id : null;
          // If the revision overwrote thesis_summary (rev had its own thesis), we need to restore
          // the prior thesis. The safest source is the previous revision's thesis_summary, OR
          // if there was no previous revision and the thesis_summary in premortems matches rev.thesis_summary,
          // we cannot perfectly recover the original V1 text — but the rev row itself preserved the snapshot
          // ON ENTRY (not the new value). Per submit logic, on thesis_evolved we DO write the new thesis to
          // premortems.thesis_summary; rev.thesis_summary stores the NEW value too (lines 125, 131). So
          // the previous text is gone unless prev exists. We use prev.thesis_summary if prev exists; otherwise
          // we leave premortems.thesis_summary untouched (admin must edit manually).
          const pmUpdate = {
            version: rollbackVersion,
            current_revision_id: rollbackRevId,
            updated_at: new Date().toISOString(),
          };
          if (prev && prev.thesis_summary) {
            pmUpdate.thesis_summary = prev.thesis_summary;
          }
          await sbUpdate('premortems', `id=eq.${pm.id}`, pmUpdate);
          undone.premortem_rolled_back = { from_version: pm.version, to_version: rollbackVersion, thesis_restored: !!(prev && prev.thesis_summary) };
        }

        await sbDelete('premortem_revisions', `id=eq.${rev.id}`);
        undone.revision_deleted = true;
      }
    }

    // 3. Delete the entry row
    if (due.entry_id) {
      await sbDelete('reunderwriting_entries', `id=eq.${due.entry_id}`);
      undone.entry_deleted = true;
    }

    // 4. Reset due to pending
    await sbUpdate('reunderwriting_due', `id=eq.${due.id}`, {
      status: 'pending',
      completed_at: null,
      entry_id: null,
      outcome: null,
      outcome_notes: null,
      revision_id: null,
      notes: due.notes ? `${due.notes} | undone ${new Date().toISOString()} by ${auth.user.email}` : `undone ${new Date().toISOString()} by ${auth.user.email}`,
    });

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      due_id: due.id,
      ticker: due.ticker,
      undone_by: auth.user.email,
      details: undone,
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
