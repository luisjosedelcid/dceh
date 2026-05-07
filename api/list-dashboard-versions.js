// GET /api/list-dashboard-versions?ticker=MSFT
// Public endpoint — lists all versions for a ticker, latest first.
// Returns: { ticker, versions: [ { fiscal_period, period_end_date, is_latest, excel_url, notes } ] }

const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ticker = String(req.query.ticker || '').toUpperCase().trim();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(200).json({ ticker, versions: [] });
  }

  try {
    const rows = await sbSelect(
      'company_dashboards',
      `select=fiscal_period,period_end_date,is_latest,excel_url,notes&ticker=eq.${ticker}&order=period_end_date.desc`
    );
    return res.status(200).json({ ticker, versions: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
