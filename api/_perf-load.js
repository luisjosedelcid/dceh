// Loads all data needed by _perf-calc.js from Supabase, then runs computeDaily.
const { sbSelect } = require('./_supabase');
const { computeDaily } = require('./_perf-calc');

async function loadAndCompute({ endDate } = {}) {
  // 1) Pull tx, cf, prices in parallel
  const [tx, cf, prices] = await Promise.all([
    sbSelect('transactions', 'select=trade_date,ticker,side,qty,price_native,fx_to_usd,fee_native&order=trade_date.asc&limit=10000'),
    sbSelect('cashflows',    'select=occurred_at,cf_type,ticker,amount_native,fx_to_usd&order=occurred_at.asc&limit=10000'),
    sbSelect('prices_daily', 'select=ticker,price_date,close_native&order=price_date.asc&limit=100000'),
  ]);

  if (tx.length === 0 && cf.length === 0) {
    return { dailySeries: [], holdings: [], kpis: null };
  }

  const iwquSeries = prices.filter(p => p.ticker === 'IWQU.L');
  const otherPrices = prices.filter(p => p.ticker !== 'IWQU.L');

  const startDate = [
    ...tx.map(t => t.trade_date),
    ...cf.map(c => c.occurred_at),
  ].sort()[0];

  const today = new Date();
  // Use yesterday as end if before market close today (price might not be in DB yet).
  // Caller can override with endDate. Default to last available IWQU.L date or today, whichever earlier.
  const lastIwqu = iwquSeries.length ? iwquSeries[iwquSeries.length - 1].price_date : null;
  const todayStr = today.toISOString().slice(0, 10);
  const computedEnd = endDate || (lastIwqu && lastIwqu < todayStr ? lastIwqu : todayStr);

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
