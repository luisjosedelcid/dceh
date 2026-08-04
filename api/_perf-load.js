// Loads all data needed by _perf-calc.js from Supabase, then runs computeDaily.
const { sbSelect } = require('./_supabase');
const { computeDaily } = require('./_perf-calc');

async function loadAndCompute({ endDate } = {}) {
  // 1) Pull tx, cf, prices in parallel
  const [tx, cf, prices] = await Promise.all([
    sbSelect('transactions', 'select=trade_date,ticker,side,qty,price_native,fx_to_usd,fee_native,notes&order=trade_date.asc&limit=10000'),
    sbSelect('cashflows',    'select=occurred_at,cf_type,ticker,amount_native,fx_to_usd&order=occurred_at.asc&limit=10000'),
    sbSelect('prices_daily', 'select=ticker,price_date,close_native&order=price_date.asc&limit=100000'),
  ]);

  if (tx.length === 0 && cf.length === 0) {
    return { dailySeries: [], holdings: [], kpis: null };
  }

  // Benchmark: S&P 500 (via SPY ETF). Legacy `iwquSeries` var name kept because
  // downstream schema fields (portfolio_snapshots.benchmark_urth, api response
  // key `iwqu_norm`) are still named after prior benchmarks. Renaming those
  // would break the daily snapshot cron and the /api/performance response shape.
  const iwquSeries = prices.filter(p => p.ticker === 'SPY');
  const otherPrices = prices.filter(p => p.ticker !== 'SPY');

  const startDate = [
    ...tx.map(t => t.trade_date),
    ...cf.map(c => c.occurred_at),
  ].sort()[0];

  const today = new Date();
  // End = max(last tx date, last cf date) so the window covers all portfolio
  // activity even when the benchmark series (SPY) is stale. Days without an
  // SPY close simply get iwqu_norm=null on the series — they don't truncate
  // the whole dashboard. Caller can still override via endDate.
  const todayStr = today.toISOString().slice(0, 10);
  const lastTx = tx.length ? tx[tx.length - 1].trade_date : null;
  const lastCf = cf.length ? cf[cf.length - 1].occurred_at : null;
  const lastActivity = [lastTx, lastCf, startDate].filter(Boolean).sort().slice(-1)[0];
  const computedEnd = endDate || (lastActivity && lastActivity > todayStr ? lastActivity : todayStr);

  return computeDaily({
    transactions: tx,
    cashflows: cf,
    prices: otherPrices,
    iwquSeries,
    startDate,
    endDate: computedEnd,
  });
}

module.exports = { loadAndCompute };
