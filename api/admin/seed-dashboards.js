// DCE Holdings — Seed company_dashboards table from /public/companies/*.json
// POST /api/admin/seed-dashboards
//   body: { entries: [ { ticker, fiscal_period, period_end_date, json_file, excel_url, is_latest, notes } ] }
// json_file is the relative path inside /public/companies/ (e.g. "msft_ltm2026q3.json").
//
// Auth: x-admin-token

const fs = require('fs');
const path = require('path');
const { verifyAdminToken } = require('../_admin-auth');
const { sbInsert, sbDelete, sbSelect } = require('../_supabase');

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
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'entries[] required' });

    const results = [];
    const baseDir = path.join(process.cwd(), 'public', 'companies');

    for (const e of entries) {
      const ticker = String(e.ticker || '').toUpperCase().trim();
      const fiscal_period = String(e.fiscal_period || '').trim();
      const period_end_date = String(e.period_end_date || '').trim();
      const json_file = String(e.json_file || '').trim();
      const is_latest = !!e.is_latest;
      const excel_url = e.excel_url || null;
      const notes = e.notes || null;

      if (!ticker || !fiscal_period || !period_end_date || !json_file) {
        results.push({ ticker, fiscal_period, ok: false, error: 'missing required fields' });
        continue;
      }

      const filePath = path.join(baseDir, json_file);
      let dashboard_json;
      try {
        dashboard_json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        results.push({ ticker, fiscal_period, ok: false, error: `read ${json_file}: ${err.message}` });
        continue;
      }

      // Delete any existing row with same (ticker, fiscal_period) for idempotency
      try {
        await sbDelete('company_dashboards', `ticker=eq.${ticker}&fiscal_period=eq.${encodeURIComponent(fiscal_period)}`);
      } catch (err) {
        // Ignore if nothing to delete
      }

      // If this entry is_latest=true, demote any existing latest for this ticker
      if (is_latest) {
        try {
          const existing = await sbSelect('company_dashboards', `select=id&ticker=eq.${ticker}&is_latest=is.true`);
          for (const r of existing) {
            const { sbUpdate } = require('../_supabase');
            await sbUpdate('company_dashboards', `id=eq.${r.id}`, { is_latest: false });
          }
        } catch (err) {
          // log only
        }
      }

      try {
        const row = await sbInsert('company_dashboards', {
          ticker, fiscal_period, period_end_date,
          dashboard_json, excel_url, is_latest, notes,
        });
        results.push({ ticker, fiscal_period, ok: true, id: Array.isArray(row) ? row[0]?.id : row?.id });
      } catch (err) {
        results.push({ ticker, fiscal_period, ok: false, error: err.message });
      }
    }

    res.status(200).json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
