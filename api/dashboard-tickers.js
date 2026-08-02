// GET /api/dashboard-tickers → { tickers: ['MSFT2','LULU',...] }
// Returns distinct tickers that have an active dashboard_html asset.
// Used by universe.html to show the 🌐 button.

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = await requireRole(req, ['admin', 'analyst', 'any']);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const rows = await sbSelect(
      'pipeline_card_assets',
      'kind=eq.dashboard_html&active=eq.true&select=ticker'
    );
    const set = new Set();
    rows.forEach(r => { if (r.ticker) set.add(String(r.ticker).toUpperCase()); });
    return res.status(200).json({ tickers: Array.from(set) });
  } catch (e) {
    console.error('dashboard-tickers error', e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
};
