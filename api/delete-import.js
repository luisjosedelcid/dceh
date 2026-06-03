// DCE Holdings — Delete import (batch) API (admin-only)
// POST /api/delete-import
// Header: x-admin-token: <token>
// Body: { batch_id: <uuid> }
//
// Hard-deletes all transactions and cashflows tagged with the given batch_id,
// and marks the associated report_audit row as superseded (sets a marker in
// detail; we keep the audit log immutable for compliance).
//
// Returns: { ok: true, batch_id, tx_deleted, cf_deleted }

const { sbDelete, sbSelect, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');

// Loose UUID v4 validator
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const batchId = String(body.batch_id || '').trim();
    if (!UUID_RE.test(batchId)) {
      return res.status(400).json({ error: 'batch_id must be a valid UUID' });
    }

    // Count first
    const [txRows, cfRows] = await Promise.all([
      sbSelect('transactions', `select=id&batch_id=eq.${batchId}&limit=10000`),
      sbSelect('cashflows', `select=id&batch_id=eq.${batchId}&limit=10000`),
    ]);
    const txCount = txRows ? txRows.length : 0;
    const cfCount = cfRows ? cfRows.length : 0;

    if (txCount === 0 && cfCount === 0) {
      return res.status(404).json({ error: 'no_rows_found', batch_id: batchId });
    }

    if (txCount > 0) await sbDelete('transactions', `batch_id=eq.${batchId}`);
    if (cfCount > 0) await sbDelete('cashflows', `batch_id=eq.${batchId}`);

    // Mark the audit row as superseded (best-effort; we don't delete it)
    try {
      const auditRows = await sbSelect('report_audit', `select=id,detail&batch_id=eq.${batchId}&limit=1`);
      if (auditRows && auditRows.length > 0) {
        const a = auditRows[0];
        const newDetail = `[REVERTED ${new Date().toISOString()}] ` + (a.detail || '');
        await sbUpdate('report_audit', `id=eq.${a.id}`, { detail: newDetail.slice(0, 500) });
      }
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({ ok: true, batch_id: batchId, tx_deleted: txCount, cf_deleted: cfCount });
  } catch (err) {
    console.error('[delete-import]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message || err) });
  }
};
