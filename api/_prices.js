// ────────────────────────────────────────────────────────────────────────────
// Prices helper — daily EOD closes for the Performance module.
//
// PRIMARY SOURCE: Yahoo Finance v8 chart API
//   - Free, no API key, returns timestamps + OHLC + adjclose.
//   - URL: https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?period1=<unix>&period2=<unix>&interval=1d
//
// FALLBACK INTRADAY: Finnhub /quote (only when Yahoo fails for "today's" close)
//
// SPECIAL CASE: US Treasury CUSIPs (e.g. 91282CBT7) — Yahoo doesn't carry them.
//   We synthesize a daily price as a linear interpolation between the buy
//   price (~par) and 100.00 at maturity. Maturity is inferred as the
//   trade_date of the SELL row in `transactions` for that ticker.
//
// FX: ECB daily reference rates (free) for EURUSD. Stored as USD per 1 EUR.
//   URL: https://api.frankfurter.dev/v1/<from>..<to>?base=EUR&symbols=USD
// ────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DCE-Holdings/1.0';

function ymd(d) {
  // YYYY-MM-DD in UTC
  return new Date(d * 1000).toISOString().slice(0, 10);
}

function isCusip(t) {
  // US Treasury CUSIP shape: 9 chars, alphanumeric, ends in check digit. We
  // use a loose heuristic — any 9-char ticker that isn't a typical equity.
  return /^[0-9][0-9A-Z]{8}$/.test(t);
}

// ── Yahoo daily EOD ────────────────────────────────────────────────────────
async function yahooDaily(symbol, fromDate, toDate) {
  const p1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`yahoo ${symbol} ${r.status}`);
  const j = await r.json();
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result) {
    if (j && j.chart && j.chart.error) throw new Error(`yahoo ${symbol}: ${j.chart.error.code} ${j.chart.error.description}`);
    throw new Error(`yahoo ${symbol}: empty result`);
  }
  const ts = result.timestamp || [];
  const closes = (result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue; // skip non-trading days
    out.push({
      ticker: symbol,
      price_date: ymd(ts[i]),
      close_native: Number(closes[i]),
      currency: 'USD',
      source: 'yahoo',
    });
  }
  return out;
}

// ── Finnhub /quote (today's EOD, no history) ───────────────────────────────
async function finnhubQuote(symbol) {
  const key = process.env.FINNHUB_KEY;
  if (!key) throw new Error('FINNHUB_KEY missing');
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (!r.ok) throw new Error(`finnhub ${symbol} ${r.status}`);
  const j = await r.json();
  if (!j || j.c == null) return null;
  // `t` is the last trade timestamp; we use today's UTC date for storage.
  const today = new Date().toISOString().slice(0, 10);
  return {
    ticker: symbol,
    price_date: today,
    close_native: Number(j.c),
    currency: 'USD',
    source: 'finnhub_quote',
  };
}

// ── Treasury synth ─────────────────────────────────────────────────────────
// Linear interpolation between (buy_date, buy_price) and (maturity_date, par).
// `par` defaults to 1.0 because our parser stores Treasury prices in fraction-of-par
// form (price = |amount| / qty, where qty = face value in USD). E.g. a $75k face
// bond bought for $74,731 → price_native = 0.9964 (i.e. 99.64% of par).
function synthTreasury(ticker, buyDate, buyPrice, maturityDate, fromDate, toDate, par = 1.0) {
  const dStart = new Date(buyDate + 'T00:00:00Z').getTime();
  const dEnd   = new Date(maturityDate + 'T00:00:00Z').getTime();
  const slope  = (par - buyPrice) / Math.max(1, (dEnd - dStart) / 86400000);
  const out = [];
  let cur = new Date(Math.max(dStart, new Date(fromDate + 'T00:00:00Z').getTime()));
  const end = new Date(Math.min(dEnd, new Date(toDate + 'T00:00:00Z').getTime()));
  while (cur.getTime() <= end.getTime()) {
    const days = (cur.getTime() - dStart) / 86400000;
    const px = Math.min(par, buyPrice + slope * days);
    out.push({
      ticker,
      price_date: cur.toISOString().slice(0, 10),
      close_native: Number(px.toFixed(6)),
      currency: 'USD',
      source: 'synth_treasury',
    });
    cur = new Date(cur.getTime() + 86400000);
  }
  return out;
}

// ── ECB / Frankfurter FX ───────────────────────────────────────────────────
async function ecbDaily(pair, fromDate, toDate) {
  // pair format 'EURUSD'  (= USD per 1 EUR)
  const base   = pair.slice(0, 3);
  const quote  = pair.slice(3, 6);
  const url = `https://api.frankfurter.dev/v1/${fromDate}..${toDate}?base=${base}&symbols=${quote}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ecb ${pair} ${r.status}`);
  const j = await r.json();
  const rates = j.rates || {};
  const out = [];
  for (const [date, obj] of Object.entries(rates)) {
    if (obj && obj[quote] != null) {
      out.push({
        pair,
        rate_date: date,
        rate: Number(obj[quote]),
        source: 'ecb',
      });
    }
  }
  return out;
}

// ── Main entry: fetch a ticker for a date range using best source ──────────
async function fetchPriceSeries(ticker, fromDate, toDate, opts = {}) {
  if (isCusip(ticker)) {
    // Caller must pass treasury params via opts.treasury = {buyDate,buyPrice,maturityDate}
    const t = opts.treasury;
    if (!t) throw new Error(`Treasury ${ticker}: missing opts.treasury (buyDate/buyPrice/maturityDate)`);
    return synthTreasury(ticker, t.buyDate, t.buyPrice, t.maturityDate, fromDate, toDate);
  }
  // Equities / ETFs → Yahoo
  return yahooDaily(ticker, fromDate, toDate);
}

module.exports = {
  fetchPriceSeries,
  yahooDaily,
  finnhubQuote,
  synthTreasury,
  ecbDaily,
  isCusip,
};
