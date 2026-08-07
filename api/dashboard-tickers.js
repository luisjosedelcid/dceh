// GET /api/dashboard-tickers → { tickers: ['MSFT2','LULU',...] }
// Returns distinct tickers that have a PUBLISHED dashboard in
// company_dashboards (is_latest=true). Used by universe.html to
// show the 🌐 button on ad-hoc tickers.

const { requireCapability } = require('./_require-capability');
const { sbSelect } = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = await requireCapability(req, 'DB-02');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const rows = await sbSelect(
      'company_dashboards',
      'select=ticker&is_latest=is.true'
    );
    const set = new Set();
    rows.forEach(r => { if (r.ticker) set.add(String(r.ticker).toUpperCase()); });
    return res.status(200).json({ tickers: Array.from(set) });
  } catch (e) {
    console.error('dashboard-tickers error', e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
};
