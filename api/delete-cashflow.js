// DCE Holdings — Cashflow delete API (admin-only)
// POST /api/delete-cashflow
// Header: x-admin-token: <token>
// Body: { id: <number> }
//
// Hard-deletes a single cashflow row by id. Use as the "Undo" affordance for
// a manually-added contribution / withdrawal / dividend that was loaded by
// mistake. Schwab CSV re-imports are idempotent, so a deleted CSV row will
// reappear on the next import — that's intentional.
//
// Returns: { ok: true, id }

const { sbDelete, sbSelect } = require('./_supabase');
const { requireCapability } = require('./_require-capability');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const auth = await requireCapability(req, 'PF-03');
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
    const existing = await sbSelect('cashflows', `select=id,occurred_at,cf_type,amount_native,source&id=eq.${id}&limit=1`);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    const row = existing[0];

    // Hard-delete (cashflows are simple ledger entries — no FKs to other tables)
    await sbDelete('cashflows', `id=eq.${id}`);

    return res.status(200).json({ ok: true, id, deleted: row });
  } catch (err) {
    console.error('[delete-cashflow]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message || err) });
  }
};
