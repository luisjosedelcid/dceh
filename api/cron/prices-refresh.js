// GET /api/cron/prices-refresh
// Vercel cron — runs daily, fetches the last ~7 days of EOD for every tracked
// ticker (covers weekend gaps and late-arriving updates) and upserts to
// prices_daily. Authenticated by Authorization: Bearer <CRON_SECRET>.
//
// For first-time backfill of long history, call /api/admin-backfill-prices.

const { sbSelect, sbUpsert } = require('../_supabase');
const { fetchPriceSeries, isCusip } = require('../_prices');

module.exports = async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const today = new Date();
  const toDate = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 8 * 86400000); // 8 days back
  const fromDate = from.toISOString().slice(0, 10);

  let tickers = [];
  let allTx = [];
  try {
    const rows = await sbSelect('tickers_tracked', 'select=ticker,first_trade_date');
    tickers = rows.map(r => r.ticker);
    allTx = await sbSelect('transactions', 'select=ticker,side,trade_date,price_native&order=trade_date.asc');
  } catch (e) {
    res.status(500).json({ error: 'Init failed', detail: String(e).slice(0, 300) });
    return;
  }

  const perTicker = {};
  const errors = [];

  for (const ticker of tickers) {
    try {
      let series;
      if (isCusip(ticker)) {
        const txs = allTx.filter(t => t.ticker === ticker);
        const buy = txs.find(t => t.side === 'BUY');
        const sell = txs.find(t => t.side === 'SELL');
        if (!buy) { errors.push({ ticker, reason: 'no BUY' }); continue; }
        const maturityDate = (sell && sell.trade_date) || toDate;
        // Already-matured bonds: skip the cron (data is static).
        if (maturityDate < fromDate) { perTicker[ticker] = { rows: 0, reason: 'matured' }; continue; }
        series = await fetchPriceSeries(ticker, fromDate, toDate, {
          treasury: { buyDate: buy.trade_date, buyPrice: Number(buy.price_native), maturityDate },
        });
      } else {
        series = await fetchPriceSeries(ticker, fromDate, toDate);
      }
      if (series.length) {
        const out = await sbUpsert('prices_daily', series, 'ticker,price_date');
        perTicker[ticker] = { rows: series.length, upserted: Array.isArray(out) ? out.length : 0 };
      } else {
        perTicker[ticker] = { rows: 0 };
      }
    } catch (e) {
      errors.push({ ticker, reason: String(e.message || e).slice(0, 200) });
    }
  }

  res.status(200).json({ ok: true, asOf: toDate, fromDate, perTicker, errors });
};
