// DCE Holdings — Bulk delete by source API (admin-only)
// POST /api/delete-source
// Header: x-admin-token: <token>
// Body: { table: 'transactions'|'cashflows', source: <string> }
//
// Hard-deletes all rows in `table` whose `source` column equals `source`.
// Use to wipe an entire import batch (e.g. the full Schwab CSV) instead of
// removing rows one-by-one. Schwab CSV re-imports are idempotent — if you
// delete the schwab_csv source and re-import the file, all rows come back.
//
// Returns: { ok: true, table, source, count }

const { sbDelete, sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

const ALLOWED_TABLES = new Set(['transactions', 'cashflows']);

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
    const table = String(body.table || '').trim();
    const source = String(body.source || '').trim();

    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ error: 'table must be one of: transactions, cashflows' });
    }
    if (!source) {
      return res.status(400).json({ error: 'source is required' });
    }

    // Count first so we can return how many were affected.
    // PostgREST encodes string match as `eq.<value>`.
    const encodedSource = encodeURIComponent(source);
    const rows = await sbSelect(table, `select=id&source=eq.${encodedSource}&limit=10000`);
    const count = rows ? rows.length : 0;

    if (count === 0) {
      return res.status(404).json({ error: 'no_rows_found', table, source });
    }

    await sbDelete(table, `source=eq.${encodedSource}`);

    return res.status(200).json({ ok: true, table, source, count });
  } catch (err) {
    console.error('[delete-source]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err && err.message || err) });
  }
};
