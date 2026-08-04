// ═══════════════════════════════════════════════════════════════════
// Crypto history resolver — daily-close prices from Supabase
// ───────────────────────────────────────────────────────────────────
// Companion to _crypto-prices.js. Used by /api/generate-crypto-report
// and /api/generate-consolidated-report when ?as_of=YYYY-MM-DD is
// provided.
//
// Contract mirrors valueCryptoLive() so the PDF renderer is unchanged:
//   {
//     crNav:      <NAV in USD at as_of>,
//     crEnriched: [{ name, asset, quantity, priceUsd, marketUsd, isLive }],
//     asOfDate:   'YYYY-MM-DD' (the actual price date used),
//     priceSource:'historical' | 'par_fallback',
//     staleReason: <string|null>,
//   }
//
// Data source: crypto_price_history table (populated by /api/backfill-crypto
// on migration and by the daily cron at /api/cron-crypto-snapshot).
//
// Semantics:
//   - For each position with price_source.coingecko_id, pick the row with
//     the largest snapshot_date <= as_of.
//   - If no row exists (as_of predates the 365-day backfill window), fall
//     back to par (marketUsd = cost_basis_total_usd or cost_basis_unit_usd
//     × quantity). isLive=false so the UI can flag it.
// ═══════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/**
 * Load, for a list of coin ids, the most-recent price row with
 * snapshot_date <= asOfYMD. Returns { [coinId]: { snapshot_date, price_usd } }.
 */
async function loadHistoricalPrices(coinIds, asOfYMD) {
  const uniqueIds = Array.from(new Set(coinIds.filter(Boolean)));
  if (uniqueIds.length === 0) return {};

  // We pull every row for the ids up to as_of, then reduce to the latest per coin.
  // For a handful of coins and a 365-day window this is 366 rows tops — trivial.
  const { data, error } = await sb()
    .from('crypto_price_history')
    .select('coin_id, snapshot_date, price_usd')
    .in('coin_id', uniqueIds)
    .lte('snapshot_date', asOfYMD)
    .order('snapshot_date', { ascending: false });

  if (error) throw new Error('crypto_price_history query failed: ' + error.message);

  const latest = {};
  for (const row of (data || [])) {
    if (!latest[row.coin_id]) {
      latest[row.coin_id] = {
        snapshot_date: row.snapshot_date,
        price_usd: Number(row.price_usd),
      };
    }
  }
  return latest;
}

/**
 * Public: value crypto positions at a historical as-of date.
 * Mirrors valueCryptoLive() contract.
 */
async function valueCryptoAtDate(crJson, asOfYMD) {
  if (!crJson || !Array.isArray(crJson.positions) || crJson.positions.length === 0) {
    return {
      crNav: 0, crEnriched: [], asOfDate: '—', priceSource: 'par_fallback',
      staleReason: 'no positions',
    };
  }

  const ids = crJson.positions
    .filter(p => p.price_source && p.price_source.coingecko_id)
    .map(p => p.price_source.coingecko_id);

  const historical = await loadHistoricalPrices(ids, asOfYMD);

  let crNav = 0;
  const crEnriched = [];
  let priceDateSeen = null;
  let allResolvedFromHistory = true;

  for (const p of crJson.positions) {
    const cgId = p.price_source && p.price_source.coingecko_id;
    const px = cgId ? historical[cgId] : null;

    let priceUsd, marketUsd, isLive;
    if (px && px.price_usd > 0) {
      priceUsd = px.price_usd;
      marketUsd = Number(p.quantity || 0) * priceUsd;
      isLive = true;
      if (!priceDateSeen || px.snapshot_date > priceDateSeen) {
        priceDateSeen = px.snapshot_date;
      }
    } else {
      // Par-fallback: NAV = cost basis (unrealized P&L = 0 at that date).
      priceUsd = Number(p.cost_basis_unit_usd || 0);
      marketUsd = Number(p.cost_basis_total_usd || (priceUsd * Number(p.quantity || 0)));
      isLive = false;
      allResolvedFromHistory = false;
    }
    crNav += marketUsd;
    crEnriched.push({
      name: (p.asset || '?') + ' — ' + (p.asset_name || ''),
      asset: p.asset,
      quantity: Number(p.quantity || 0),
      priceUsd,
      marketUsd,
      isLive,
    });
  }

  const priceSource = allResolvedFromHistory ? 'historical' : 'par_fallback';
  const asOfDate = priceDateSeen || asOfYMD;
  const staleReason = allResolvedFromHistory
    ? null
    : `no historical price on or before ${asOfYMD} for one or more coins; par fallback used`;

  return { crNav, crEnriched, asOfDate, priceSource, staleReason };
}

module.exports = { valueCryptoAtDate, loadHistoricalPrices };
