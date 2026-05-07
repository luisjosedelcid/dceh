// GET /api/reunderwriting-detail?due_id=<id>
//   Returns the full record of a completed (or pending) re-underwriting:
//     - due row (status, outcome, completed_at, revision_id, etc.)
//     - source document (filing URL)
//     - entry (3 questions, action, kill_criteria_snapshot, reviewer)
//     - revision (if any was created — premortem_revisions row)
//
//   Used by the cockpit drawer to inspect what was signed off when the
//   committee closed a due. Read-only.
//
// Auth: any authenticated user.

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
    const dueId = Number(url.searchParams.get('due_id'));
    if (!dueId) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'due_id required' }));
      return;
    }

    // 1. Pull due + joined source_document
    const dues = await sbSelect(
      'reunderwriting_due',
      `select=id,ticker,period_end,doc_type,source_doc_id,status,due_at,completed_at,entry_id,notes,outcome,outcome_notes,revision_id,source_documents(source_url,filed_at,parsed_summary)&id=eq.${dueId}&limit=1`
    );
    if (dues.length === 0) {
      res.status(404).end(JSON.stringify({ ok: false, error: 'due not found' }));
      return;
    }
    const d = dues[0];
    const sd = d.source_documents || {};
    const due = {
      id: d.id,
      ticker: d.ticker,
      period_end: d.period_end,
      doc_type: d.doc_type,
      status: d.status,
      due_at: d.due_at,
      completed_at: d.completed_at,
      entry_id: d.entry_id,
      notes: d.notes,
      outcome: d.outcome || null,
      outcome_notes: d.outcome_notes || null,
      revision_id: d.revision_id || null,
      source_url: sd.source_url || null,
      filed_at: sd.filed_at || null,
    };

    // 2. Pull entry (if any)
    let entry = null;
    if (d.entry_id) {
      const entries = await sbSelect(
        'reunderwriting_entries',
        `select=*&id=eq.${d.entry_id}&limit=1`
      );
      entry = entries[0] || null;
    }

    // 3. Pull revision (if any)
    let revision = null;
    if (d.revision_id) {
      const revs = await sbSelect(
        'premortem_revisions',
        `select=id,premortem_id,version_num,thesis_summary,failure_modes_snapshot,change_type,change_summary,reunderwriting_due_id,ratified_by_committee,created_by,created_at&id=eq.${d.revision_id}&limit=1`
      );
      revision = revs[0] || null;
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, due, entry, revision }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
