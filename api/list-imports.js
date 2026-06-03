// GET /api/list-imports?limit=50
// Returns the list of CSV imports with their batch_id, fecha, archivo,
// counts and source. Read-only — admin or analyst.
//
// Combines report_audit (action='import_schwab') with row counts from
// transactions and cashflows (grouped by batch_id) so the UI can show
// each import as a single discrete entry that can be deleted.
//
// Also reports legacy rows (batch_id IS NULL) as a synthetic entry per
// source so the admin can clean them up too.

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

  try {
    // 1) Audit entries (one row per import, ordered desc by date)
    const auditRows = await sbSelect(
      'report_audit',
      `select=id,actor_email,filename,size_bytes,detail,created_at,batch_id&action=eq.import_schwab&order=created_at.desc&limit=${limit}`
    );

    // 2) Counts per batch_id in transactions / cashflows.
    //    Fetch the universe and tally in memory (PostgREST doesn't do GROUP BY
    //    easily over millions of rows; for tens of imports this is fine).
    const [allTx, allCf] = await Promise.all([
      sbSelect('transactions', `select=id,batch_id,source&limit=10000`),
      sbSelect('cashflows', `select=id,batch_id,source&limit=10000`),
    ]);

    const txCount = {}; // batch_id → count
    const cfCount = {};
    const legacyTx = {}; // source → count (for batch_id NULL)
    const legacyCf = {};
    for (const t of (allTx || [])) {
      if (t.batch_id) txCount[t.batch_id] = (txCount[t.batch_id] || 0) + 1;
      else legacyTx[t.source || '(none)'] = (legacyTx[t.source || '(none)'] || 0) + 1;
    }
    for (const c of (allCf || [])) {
      if (c.batch_id) cfCount[c.batch_id] = (cfCount[c.batch_id] || 0) + 1;
      else legacyCf[c.source || '(none)'] = (legacyCf[c.source || '(none)'] || 0) + 1;
    }

    // 3) Build import list
    const imports = (auditRows || []).map(a => ({
      kind: 'batch',
      batch_id: a.batch_id,
      audit_id: a.id,
      created_at: a.created_at,
      actor_email: a.actor_email,
      filename: a.filename,
      size_bytes: a.size_bytes,
      detail: a.detail,
      tx_count: a.batch_id ? (txCount[a.batch_id] || 0) : 0,
      cf_count: a.batch_id ? (cfCount[a.batch_id] || 0) : 0,
    }));

    // 4) Legacy entries (rows without batch_id, grouped by source)
    const legacy = [];
    const allSources = new Set([...Object.keys(legacyTx), ...Object.keys(legacyCf)]);
    for (const src of allSources) {
      legacy.push({
        kind: 'legacy',
        source: src,
        tx_count: legacyTx[src] || 0,
        cf_count: legacyCf[src] || 0,
      });
    }

    res.status(200).json({ ok: true, imports, legacy });
  } catch (e) {
    res.status(500).json({ error: 'Query failed', detail: String(e).slice(0, 300) });
  }
};
