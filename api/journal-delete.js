// DCE Holdings — Decision Journal soft-delete API (admin-only)
// POST /api/journal-delete
// Header: x-admin-token: <token>
// Body: { id: <number> }
//
// Sets active=false on the row. Use as the "Undo" affordance for a journal
// entry that was created by mistake. Does NOT touch trades, pipeline,
// portfolio, premortems, or linked rows. The skills (dce-decision-buy/sell)
// own those side effects when a real decision is registered through them.
//
// Returns: { ok: true, id }
//
// Why soft-delete and not hard-delete:
//  - Audit trail: the journal is a permanent record of CIO decisions.
//    Even an undo should leave a footprint (active=false flag).
//  - Re-activate is trivial via Supabase if needed.
//  - Other tables (trades, premortems) may FK to decision_journal.id.

const { sbUpdate, sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status || 401).json({ error: auth.error || 'Unauthorized' });
      return;
    }

    const body = req.body || {};
    const id = parseInt(body.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id is required (positive integer)' });
    }

    // Verify entry exists
    const existing = await sbSelect('decision_journal', `select=id,active&id=eq.${id}&limit=1`);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Soft-delete (idempotent)
    await sbUpdate('decision_journal', `id=eq.${id}`, { active: false });

    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[journal-delete]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message || err) });
  }
};
