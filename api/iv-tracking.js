// DCE Holdings — IV-Tracking read API (authenticated)
// GET /api/iv-tracking?ticker=MSFT
// Header: x-admin-token: <token>
// Returns { items: [...], by_ticker: { MSFT: [...], LULU: [...] } }
//
// Restricted: iv_tracking expone valoraciones internas (EPV/IRR);
// nunca exponer sin auth.

'use strict';

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status || 401).json({ error: auth.error || 'Unauthorized' });
      return;
    }

    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();

    let q = `select=*&order=ticker.asc,as_of_date.desc&limit=500`;
    if (ticker) q += `&ticker=eq.${encodeURIComponent(ticker)}`;

    const items = await sbSelect('iv_tracking', q);

    // Group by ticker for convenience
    const by_ticker = {};
    for (const r of items) {
      if (!by_ticker[r.ticker]) by_ticker[r.ticker] = [];
      by_ticker[r.ticker].push(r);
    }

    // Latest entry per ticker (first one in each array since order is desc)
    const latest = {};
    for (const t of Object.keys(by_ticker)) {
      latest[t] = by_ticker[t][0];
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json({
      items,
      by_ticker,
      latest,
      methods: ['EPV', 'IRR', 'HYBRID'],
      signal_zones: ['fat_pitch', 'buy_hold', 'fair', 'expensive', 'bubble'],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
