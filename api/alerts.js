// DCE Holdings — Price Alerts public read API
// GET /api/alerts            → all alerts (active + recently triggered)
// GET /api/alerts?ticker=XYZ → filter by ticker
// GET /api/alerts?scope=portfolio|covered
// Returns { items: [...], by_ticker: { TICKER: { floor, ceiling } } }

const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    const scope = (req.query.scope || '').toString().toLowerCase().trim();

    let q = `select=*&order=ticker.asc,alert_type.asc&limit=500`;
    if (ticker) q += `&ticker=eq.${encodeURIComponent(ticker)}`;
    if (['portfolio', 'covered'].includes(scope)) q += `&scope=eq.${scope}`;

    const items = await sbSelect('price_alerts', q);

    // Build a fast lookup by ticker → { floor, ceiling }
    const by_ticker = {};
    for (const r of items) {
      if (!by_ticker[r.ticker]) by_ticker[r.ticker] = { floor: null, ceiling: null };
      // Prefer active over fired; if multiple of same type, keep the most recently created
      const existing = by_ticker[r.ticker][r.alert_type];
      if (!existing || (r.active && !existing.active) || (r.active === existing.active && r.id > existing.id)) {
        by_ticker[r.ticker][r.alert_type] = r;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    res.status(200).json({ items, by_ticker });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
