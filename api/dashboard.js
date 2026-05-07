// GET /api/dashboard?ticker=MSFT&period=LTM_2026Q3
// Public endpoint — returns the JSON payload for /company.html.
// If `period` is omitted, returns the latest version for that ticker.
// Falls back to /public/companies/<ticker>.json if Supabase has no row,
// to keep the site working during the rollout window.

const fs = require('fs');
const path = require('path');
const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ticker = String(req.query.ticker || '').toUpperCase().trim();
  const period = req.query.period ? String(req.query.period).trim() : null;

  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Try Supabase first
  if (hasSupabase) {
    try {
      let rows;
      if (period) {
        rows = await sbSelect(
          'company_dashboards',
          `select=ticker,fiscal_period,period_end_date,dashboard_json,excel_url,is_latest,notes&ticker=eq.${ticker}&fiscal_period=eq.${encodeURIComponent(period)}&limit=1`
        );
      } else {
        rows = await sbSelect(
          'company_dashboards',
          `select=ticker,fiscal_period,period_end_date,dashboard_json,excel_url,is_latest,notes&ticker=eq.${ticker}&is_latest=is.true&limit=1`
        );
      }
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        const payload = row.dashboard_json || {};
        // Inject version metadata so the frontend can render the banner/selector.
        payload.__version = {
          fiscal_period: row.fiscal_period,
          period_end_date: row.period_end_date,
          is_latest: row.is_latest,
          excel_url: row.excel_url,
          notes: row.notes,
        };
        return res.status(200).json(payload);
      }
      // If period was specified but missing, return 404 explicitly.
      if (period) {
        return res.status(404).json({ error: `No data for ${ticker} ${period}` });
      }
      // Otherwise fall through to file fallback.
    } catch (err) {
      // Log only; fall through to file fallback.
      console.warn('[dashboard] Supabase lookup failed:', err.message);
    }
  }

  // Fallback: read from /public/companies/<ticker>.json
  try {
    const filePath = path.join(process.cwd(), 'public', 'companies', `${ticker.toLowerCase()}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.__version = { fiscal_period: null, period_end_date: null, is_latest: true, fallback: true };
    return res.status(200).json(data);
  } catch (err) {
    return res.status(404).json({ error: `No dashboard for ${ticker}` });
  }
};
