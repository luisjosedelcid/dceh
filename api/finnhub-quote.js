// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Finnhub Quote Proxy
// ───────────────────────────────────────────────────────────────────
// Server-side proxy to keep the Finnhub API key out of the client.
// Replaces direct calls from portfolio.html / screener.html / universe.html.
//
// GET /api/finnhub-quote?symbol=MSFT
//   → { c, pc, dp, h, l, o, t, _symbol }
//
// GET /api/finnhub-quote?profile=1&symbol=MSFT
//   → /stock/profile2 passthrough (used by screener for sector/industry)
//
// Public read by design (the data itself is non-sensitive market data),
// but the API key is hidden. Light Cache-Control to absorb bursts.
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').toString().toUpperCase().trim();
    const profile = req.query.profile === '1' || req.query.profile === 'true';

    if (!symbol || !/^[A-Z0-9.\-]{1,15}$/.test(symbol)) {
      res.status(400).json({ error: 'Invalid or missing symbol' });
      return;
    }

    const FH_KEY = process.env.FINNHUB_KEY;
    if (!FH_KEY) {
      res.status(500).json({ error: 'FINNHUB_KEY not configured' });
      return;
    }

    const path = profile ? '/stock/profile2' : '/quote';
    const url = `https://finnhub.io/api/v1${path}?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`;

    const r = await fetch(url);
    if (!r.ok) {
      res.status(r.status).json({ error: `Finnhub ${r.status}` });
      return;
    }
    const data = await r.json();
    data._symbol = symbol;

    // 30s edge cache — quotes are intraday but we don't need second-level freshness
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
