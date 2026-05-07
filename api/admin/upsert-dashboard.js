// POST /api/admin/upsert-dashboard
// Body: { ticker, fiscal_period, period_end_date, dashboard_json, excel_url?, notes?, is_latest? }
// Auth: x-admin-token
//
// Behavior:
//   - If is_latest=true (default), demotes any existing latest for that ticker to false
//     and inserts the new row as latest.
//   - If is_latest=false, just inserts/updates the row without changing latest pointers.
//   - Idempotent: deletes any existing row with same (ticker, fiscal_period) before insert.

const { verifyAdminToken } = require('../_admin-auth');
const { sbInsert, sbDelete, sbSelect, sbUpdate } = require('../_supabase');

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

module.exports = async (req, res) => {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }
  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readJson(req);
    const ticker = String(body.ticker || '').toUpperCase().trim();
    const fiscal_period = String(body.fiscal_period || '').trim();
    const period_end_date = String(body.period_end_date || '').trim();
    const dashboard_json = body.dashboard_json;
    const excel_url = body.excel_url || null;
    const notes = body.notes || null;
    const is_latest = body.is_latest !== false; // default true

    if (!ticker || !fiscal_period || !period_end_date || !dashboard_json) {
      return res.status(400).json({ error: 'ticker, fiscal_period, period_end_date, dashboard_json required' });
    }

    // 1) Demote existing latest for this ticker if we're inserting a new latest
    if (is_latest) {
      try {
        const existing = await sbSelect(
          'company_dashboards',
          `select=id&ticker=eq.${ticker}&is_latest=is.true`
        );
        for (const r of existing) {
          await sbUpdate('company_dashboards', `id=eq.${r.id}`, { is_latest: false });
        }
      } catch (err) {
        // Best-effort — continue even if no existing latest
      }
    }

    // 2) Idempotent insert: delete any row with same (ticker, fiscal_period)
    try {
      await sbDelete(
        'company_dashboards',
        `ticker=eq.${ticker}&fiscal_period=eq.${encodeURIComponent(fiscal_period)}`
      );
    } catch (_) {
      // Ignore if nothing to delete
    }

    // 3) Insert
    const row = await sbInsert('company_dashboards', {
      ticker,
      fiscal_period,
      period_end_date,
      dashboard_json,
      excel_url,
      is_latest,
      notes,
    });

    res.status(200).json({
      ok: true,
      id: Array.isArray(row) ? row[0]?.id : row?.id,
      ticker,
      fiscal_period,
      is_latest,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
