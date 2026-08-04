// ═══════════════════════════════════════════════════════════════════
// Crypto spot prices — server-side CoinGecko fetch
// ───────────────────────────────────────────────────────────────────
// The browser uses api.coingecko.com/api/v3/simple/price to overlay
// live prices on top of public/crypto_positions.json. The PDF
// endpoints need the same behavior so the Consolidated Snapshot and
// the Crypto sleeve report stop showing a stale 2026-05-07 NAV.
//
// CoinGecko free tier:
//   - simple/price is public and unauthenticated
//   - CoinGecko-Demo-API-Key header is optional (increases rate-limit
//     from 5-15/min to 30/min); we use it if COINGECKO_API_KEY is set
//   - Rate-limit failures fall back to the static snapshot in the
//     JSON so the endpoint stays responsive.
//
// Returns:
//   { ok: true, prices: { <cg_id>: { last: 2.14, ts: Date } }, source: 'coingecko' }
//   { ok: false, error: '...' }
// ═══════════════════════════════════════════════════════════════════

// Module-level cache. Vercel serverless runtime keeps warm instances alive
// long enough for two back-to-back PDF requests (Consolidated + Crypto) to
// share the same price snapshot. TTL is intentionally short so live spot
// still refreshes on the next report generation.
const PRICE_CACHE_TTL_MS = 60_000;
const _priceCache = new Map(); // key: sorted-ids -> { at:number, prices, source }

async function fetchCryptoPrices(coingeckoIds, timeoutMs = 4000) {
  if (!Array.isArray(coingeckoIds) || coingeckoIds.length === 0) {
    return { ok: true, prices: {}, source: 'noop' };
  }
  const cacheKey = [...coingeckoIds].sort().join(',');
  const cached = _priceCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < PRICE_CACHE_TTL_MS) {
    return { ok: true, prices: cached.prices, source: cached.source + '_cached' };
  }
  const url = 'https://api.coingecko.com/api/v3/simple/price'
            + '?ids=' + encodeURIComponent(coingeckoIds.join(','))
            + '&vs_currencies=usd'
            + '&include_last_updated_at=true';

  const headers = { accept: 'application/json' };
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, error: `coingecko HTTP ${resp.status}` };
    }
    const j = await resp.json();
    const prices = {};
    for (const id of coingeckoIds) {
      const row = j[id];
      if (row && typeof row.usd === 'number' && row.usd > 0) {
        prices[id] = {
          last: row.usd,
          ts: row.last_updated_at ? new Date(row.last_updated_at * 1000) : new Date(),
        };
      }
    }
    _priceCache.set(cacheKey, { at: Date.now(), prices, source: 'coingecko' });
    return { ok: true, prices, source: 'coingecko' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'coingecko_timeout' : (err.message || 'coingecko_error') };
  } finally {
    clearTimeout(timer);
  }
}

// Resolve NAV for the crypto sleeve, using live prices when available
// and falling back to the static snapshot in the JSON.
//
// Returns:
//   {
//     crNav:            <live NAV or static snapshot>,
//     crEnriched:       [{ name, marketUsd, quantity, priceUsd }],
//     asOfDate:         'YYYY-MM-DD' (live date if live, else static date),
//     priceSource:      'live' | 'static',
//     staleReason:      <string|null>,
//   }
async function valueCryptoLive(crJson, timeoutMs = 4000) {
  if (!crJson || !Array.isArray(crJson.positions) || crJson.positions.length === 0) {
    return {
      crNav: 0, crEnriched: [], asOfDate: '—', priceSource: 'static', staleReason: 'no positions',
    };
  }

  const ids = crJson.positions
    .filter(p => p.price_source && p.price_source.live && p.price_source.coingecko_id)
    .map(p => p.price_source.coingecko_id);

  const priceResult = await fetchCryptoPrices(ids, timeoutMs);

  let crNav = 0;
  const crEnriched = [];
  let livePricedCount = 0;
  let latestTs = null;

  for (const p of crJson.positions) {
    const cgId = p.price_source && p.price_source.coingecko_id;
    const wantsLive = !!(p.price_source && p.price_source.live && cgId);
    const livePx = wantsLive && priceResult.ok ? priceResult.prices[cgId] : null;

    let priceUsd, marketUsd;
    if (livePx && livePx.last > 0) {
      priceUsd = livePx.last;
      marketUsd = Number(p.quantity || 0) * priceUsd;
      livePricedCount++;
      if (!latestTs || livePx.ts > latestTs) latestTs = livePx.ts;
    } else {
      // Fallback: cost basis or static snapshot
      priceUsd = Number(p.cost_basis_unit_usd || 0);
      marketUsd = Number(p.mv_snapshot_usd || p.cost_basis_total_usd || 0);
    }
    crNav += marketUsd;
    crEnriched.push({
      name: (p.asset || '?') + ' — ' + (p.asset_name || ''),
      asset: p.asset,
      quantity: Number(p.quantity || 0),
      priceUsd,
      marketUsd,
      isLive: !!(livePx && livePx.last > 0),
    });
  }

  const gotAllLive = livePricedCount === ids.length && livePricedCount > 0;
  let asOfDate, priceSource, staleReason;
  if (gotAllLive && latestTs) {
    asOfDate = latestTs.toISOString().slice(0, 10);
    priceSource = 'live';
    staleReason = null;
  } else {
    asOfDate = crJson.as_of_static_data || '—';
    priceSource = 'static';
    staleReason = priceResult.ok
      ? (livePricedCount === 0 ? 'no live prices returned' : 'partial live prices')
      : `coingecko unavailable (${priceResult.error})`;
  }

  return { crNav, crEnriched, asOfDate, priceSource, staleReason };
}

module.exports = { fetchCryptoPrices, valueCryptoLive };
