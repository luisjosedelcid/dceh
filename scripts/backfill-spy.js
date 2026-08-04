// One-off SPY backfill from Yahoo Finance -> prices_daily.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-spy.js
const { fetchPriceSeries } = require('../api/_prices');
const { sbUpsert } = require('../api/_supabase');

(async () => {
  const fromDate = '2025-09-01';
  const toDate = new Date().toISOString().slice(0, 10);
  console.log(`Fetching SPY EOD from ${fromDate} to ${toDate}...`);
  const series = await fetchPriceSeries('SPY', fromDate, toDate);
  console.log(`Got ${series.length} rows. First: ${series[0]?.price_date} $${series[0]?.close_native}  Last: ${series[series.length-1]?.price_date} $${series[series.length-1]?.close_native}`);
  const rows = series.map(r => ({ ticker: 'SPY', price_date: r.price_date, close_native: r.close_native }));
  await sbUpsert('prices_daily', rows, 'ticker,price_date');
  console.log(`Upserted ${rows.length} rows to prices_daily.`);
})();
