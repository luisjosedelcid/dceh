// POST /api/admin-backfill-prices
// Body (optional JSON): { fromDate?: 'YYYY-MM-DD', toDate?: 'YYYY-MM-DD', tickers?: string[] }
// Header: x-admin-token
//
// Fetches EOD prices for every ticker in `tickers_tracked` (or the explicit
// list passed in) from Yahoo Finance, plus a synthesized series for any
// Treasury CUSIP based on its BUY/SELL transactions. Upserts to prices_daily.
//
// Returns: { ok, ranges, perTicker: { TICKER: { rows, source, range } }, errors }

const { requireRole } = require('./_require-role');
const { sbSelect, sbUpsert } = require('./_supabase');
const { fetchPriceSeries, isCusip } = require('./_prices');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // Body
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Discover tickers
  let rows;
  try {
    rows = await sbSelect('tickers_tracked', 'select=ticker,first_trade_date');
  } catch (e) {
    res.status(500).json({ error: 'Failed to read tickers_tracked', detail: String(e).slice(0, 300) });
    return;
  }
  let tickers = rows.map(r => r.ticker);
  if (Array.isArray(body.tickers) && body.tickers.length) {
    const allowed = new Set(body.tickers.map(t => String(t).toUpperCase()));
    tickers = tickers.filter(t => allowed.has(t));
  }
  if (!tickers.length) {
    res.status(400).json({ error: 'No tickers to backfill' });
    return;
  }

  // Date range
  const today = new Date().toISOString().slice(0, 10);
  const toDate = body.toDate || today;

  // For Treasury synth we need transaction context
  let allTx = [];
  try {
    allTx = await sbSelect('transactions', 'select=ticker,side,trade_date,price_native&order=trade_date.asc');
  } catch (e) {
    // proceed without — only Treasuries will fail
  }

  const perTicker = {};
  const errors = [];

  for (const ticker of tickers) {
    const meta = rows.find(r => r.ticker === ticker) || {};
    const fromDate = body.fromDate || meta.first_trade_date || '2025-09-01';
    try {
      let series;
      if (isCusip(ticker)) {
        const txs = allTx.filter(t => t.ticker === ticker);
        const buy = txs.find(t => t.side === 'BUY');
        const sell = txs.find(t => t.side === 'SELL');
        if (!buy) {
          errors.push({ ticker, reason: 'Treasury but no BUY transaction found' });
          continue;
        }
        const maturityDate = (sell && sell.trade_date) || toDate;
        series = await fetchPriceSeries(ticker, fromDate, toDate, {
          treasury: {
            buyDate: buy.trade_date,
            buyPrice: Number(buy.price_native),
            maturityDate,
          },
        });
      } else {
        series = await fetchPriceSeries(ticker, fromDate, toDate);
      }
      if (series.length) {
        // Upsert in chunks of 500 to keep payload sane
        const CHUNK = 500;
        let upserted = 0;
        for (let i = 0; i < series.length; i += CHUNK) {
          const chunk = series.slice(i, i + CHUNK);
          const out = await sbUpsert('prices_daily', chunk, 'ticker,price_date');
          upserted += Array.isArray(out) ? out.length : 0;
        }
        perTicker[ticker] = {
          rows: series.length,
          upserted,
          source: series[0].source,
          range: { from: series[0].price_date, to: series[series.length - 1].price_date },
        };
      } else {
        perTicker[ticker] = { rows: 0, source: 'none', range: null };
      }
    } catch (e) {
      errors.push({ ticker, reason: String(e.message || e).slice(0, 200) });
    }
  }

  res.status(200).json({
    ok: true,
    asOf: today,
    perTicker,
    errors,
  });
};
