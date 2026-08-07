// DCE Holdings — Transaction delete API (admin-only)
// POST /api/delete-transaction
// Header: x-admin-token: <token>
// Body: { id: <number> }
//
// Hard-deletes a single transaction row by id. Use as the "Undo" affordance
// for a manually-added buy/sell that was loaded by mistake. Schwab CSV
// re-imports are idempotent, so a deleted CSV row will reappear on the
// next import — that's intentional.
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
    const existing = await sbSelect('transactions', `select=id,trade_date,ticker,side,qty,price_native,source&id=eq.${id}&limit=1`);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    const row = existing[0];

    await sbDelete('transactions', `id=eq.${id}`);

    return res.status(200).json({ ok: true, id, deleted: row });
  } catch (err) {
    console.error('[delete-transaction]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message || err) });
  }
};
