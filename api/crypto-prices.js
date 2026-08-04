// ═══════════════════════════════════════════════════════════════════
// GET /api/crypto-prices?ids=ripple,bitcoin
// Server-side proxy over CoinGecko simple/price. The performance.html
// tab hits CoinGecko directly, but corporate networks / rate-limit
// spikes / browser CORS quirks can break that call and leave NAV at
// $0 in the UI. This endpoint lets the browser retry through our
// own domain (same server that already talks to CoinGecko for PDFs).
//
// Response shape mirrors what performance.html expects internally:
//   { ok: true, prices: { <asset_upper>: { last, ts } }, source }
//
// This endpoint is read-only and does NOT require admin auth so the
// live-price refresh works for read-only viewers of /performance.html
// too. It only exposes public spot data.
// ═══════════════════════════════════════════════════════════════════

const { fetchCryptoPrices } = require('./_crypto-prices');

// Static mapping from CoinGecko id -> ticker symbol used in the UI
// (matches crypto_positions.json's `asset` field). Extend when new
// coins are added to the sleeve.
const CG_TO_ASSET = {
  ripple: 'XRP',
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  cardano: 'ADA',
  polkadot: 'DOT',
  avalanche2: 'AVAX',
};

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'method_not_allowed' });
      return;
    }
    const raw = (req.query && req.query.ids) ? String(req.query.ids) : '';
    const ids = raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'missing_ids' });
      return;
    }
    const result = await fetchCryptoPrices(ids, 4000);
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error || 'coingecko_error' });
      return;
    }
    // Key by asset ticker so the UI's CR_PRICE map lines up with
    // positions[i].asset directly (avoids a second lookup table on
    // the client side).
    const prices = {};
    for (const [cgId, row] of Object.entries(result.prices)) {
      const ticker = CG_TO_ASSET[cgId] || cgId.toUpperCase();
      prices[ticker] = {
        last: row.last,
        ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      };
    }
    res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
    res.status(200).json({ ok: true, prices, source: result.source });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || 'unhandled_error' });
  }
};
