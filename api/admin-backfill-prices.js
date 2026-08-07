// POST /api/admin-backfill-prices
// Body (optional JSON): { fromDate?: 'YYYY-MM-DD', toDate?: 'YYYY-MM-DD', tickers?: string[] }
// Header: x-admin-token
//
// Fetches EOD prices for every ticker in `tickers_tracked` (or the explicit
// list passed in) from Yahoo Finance, plus a synthesized series for any
// Treasury CUSIP based on its BUY/SELL transactions. Upserts to prices_daily.
//
// Returns: { ok, ranges, perTicker: { TICKER: { rows, source, range } }, errors }

const { requireCapability } = require('./_require-capability');
const { sbSelect, sbUpsert } = require('./_supabase');
const { fetchPriceSeries, isCusip } = require('./_prices');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireCapability(req, 'SY-03');
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

  // For Treasury synth we need transaction context. `notes` carries the
  // Schwab description ('US TREASURY BILL26U S T BILL DUE 11/03/26') from
  // which we can extract the true maturity. Without it, when a Treasury has
  // no SELL yet, the fallback `maturityDate = toDate` collapses the synth
  // curve to a single point at par (1.00) on the current day, which is why
  // the UI was quoting a $510,000 face T-bill at exactly $100.00 instead
  // of the Schwab market price of $99.0621 today.
  let allTx = [];
  try {
    allTx = await sbSelect('transactions', 'select=ticker,side,trade_date,price_native,notes&order=trade_date.asc');
  } catch (e) {
    // proceed without — only Treasuries will fail
  }

  // Extract the maturity date from a Schwab-style notes string:
  //   'US TREASURY BILL26U S T BILL DUE 11/03/26' -> '2026-11-03'
  // Returns null if the ticker isn't a Treasury CUSIP or the notes lack
  // a DUE mm/dd/yy fragment.
  function parseMaturityFromNotes(ticker, notes) {
    if (!ticker || !notes) return null;
    if (!/^912[0-9A-Z]{6}$/.test(ticker)) return null;
    const m = notes.match(/DUE\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
    if (!m) return null;
    const [, mm, dd, yy] = m;
    const year = yy.length === 2 ? '20' + yy : yy;
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
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
        // Maturity priority: (1) SELL trade_date if already matured/sold,
        //                    (2) DUE mm/dd/yy parsed from BUY notes,
        //                    (3) 30-day bill fallback (buyDate + 30d),
        //                    (4) `toDate` (last resort; produces par today).
        let maturityDate = null;
        if (sell && sell.trade_date) {
          maturityDate = sell.trade_date;
        } else {
          maturityDate = parseMaturityFromNotes(ticker, buy.notes)
            || parseMaturityFromNotes(ticker, (sell && sell.notes) || null);
        }
        if (!maturityDate) {
          // Last-ditch fallback keeps behavior stable but flags via error log.
          maturityDate = toDate;
          errors.push({
            ticker,
            reason: 'Treasury: no SELL and could not parse DUE date from notes; using toDate as maturity (price will collapse to par today)',
          });
        }
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
