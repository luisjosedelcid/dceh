// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Finnhub Symbol Search Proxy
// ───────────────────────────────────────────────────────────────────
// Server-side proxy for symbol prefix lookup, used by the /research.html
// add-row autocomplete. Keeps FINNHUB_KEY out of the client.
//
// GET /api/finnhub-search?q=MS
//   → { count, result: [{ symbol, displaySymbol, description, type }, …] }
//
// Public read: the underlying data is Finnhub's public symbol dictionary;
// the only thing we hide is the API key. Longer edge cache than /quote
// because symbol metadata is essentially static intraday.
// ═══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();

    if (!q || q.length < 1 || q.length > 12) {
      res.status(400).json({ error: 'Invalid or missing q' });
      return;
    }

    const FH_KEY = process.env.FINNHUB_KEY;
    if (!FH_KEY) {
      res.status(500).json({ error: 'FINNHUB_KEY not configured' });
      return;
    }

    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FH_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      res.status(r.status).json({ error: `Finnhub ${r.status}` });
      return;
    }
    const data = await r.json();

    // Trim payload: keep top 5, drop noisy fields, prefer Common Stock over
    // ADRs / OTC junk. Finnhub returns items in relevance order already.
    const items = Array.isArray(data?.result) ? data.result : [];
    const trimmed = items
      .filter(x => x && x.symbol && !/[.:]/.test(x.symbol.slice(1))) // strip most foreign suffixes; keep e.g. BRK.B
      .slice(0, 5)
      .map(x => ({
        symbol: x.symbol,
        displaySymbol: x.displaySymbol || x.symbol,
        description: x.description || '',
        type: x.type || '',
      }));

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(200).json({ count: trimmed.length, result: trimmed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
