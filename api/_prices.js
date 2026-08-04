// ────────────────────────────────────────────────────────────────────────────
// Prices helper — daily EOD closes for the Performance module.
//
// PRIMARY SOURCE: Yahoo Finance v8 chart API
//   - Free, no API key, returns timestamps + OHLC + adjclose.
//   - URL: https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?period1=<unix>&period2=<unix>&interval=1d
//
// FALLBACK INTRADAY: Finnhub /quote (only when Yahoo fails for "today's" close)
//
// SPECIAL CASE: US Treasury CUSIPs (e.g. 91282CBT7, 912797VP9) — Yahoo doesn't
//   carry them. Primary source is FedInvest (TreasuryDirect) EOD prices by
//   CUSIP: real market marks that match the custodian statement (Schwab).
//   Endpoint returns a CSV via POST, one call per business day covers the
//   entire marketable universe. Falls back to a straight-line synth curve
//   between buy price and par at maturity when FedInvest has no rows for
//   the requested window.
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
  // 5s timeout — this is called in a live-overlay path that must never block PDF rendering.
  // AbortSignal.timeout is available in Node 18+.
  const r = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
    { signal: AbortSignal.timeout(5000) },
  );
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

// ── FedInvest real Treasury CUSIP prices ───────────────────────────────────
// TreasuryDirect publishes daily end-of-day bid/offer/eod prices for every
// marketable Treasury CUSIP (bills, notes, bonds, TIPS, FRNs). The endpoint
// expects a POSTed form and returns a CSV with 8 columns:
//   cusip, security_type, rate, maturity_date, call_date, bid, offer, eod_price
// eod_price is quoted per $100 par. We normalize to per-$1 (0.0-1.0+) to
// match the synthTreasury / prices_daily convention.
//
// Skips weekends and returns whatever business days respond OK (the site
// 302-redirects to an error page on non-trading days, which we treat as a
// no-data day rather than a hard failure).
async function fedInvestOne(dateYmd) {
  const d = new Date(dateYmd + 'T00:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return null; // skip Sat/Sun
  const day   = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const year  = d.getUTCFullYear();
  const body = `priceDateDay=${day}&priceDateMonth=${month}&priceDateYear=${year}&fileType=csv&csv=CSV+FORMAT`;
  let r;
  try {
    r = await fetch('https://treasurydirect.gov/GA-FI/FedInvest/securityPriceDetail', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 DCE-Holdings/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://treasurydirect.gov/',
        'Origin': 'https://treasurydirect.gov',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'follow',
    });
  } catch (e) {
    return null;
  }
  if (!r.ok) return null;
  const text = await r.text();
  // If we got an HTML error page, treat as a no-data day.
  if (!text || text.length < 200 || /errormessage|Try Again/i.test(text) || !/^\s*912/m.test(text)) return null;
  // Parse CSV
  const rows = new Map(); // cusip -> {bid, offer, eod, maturity}
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || !/^912/.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 8) continue;
    const cusip = parts[0].trim();
    const bid   = Number(parts[5]);
    const offer = Number(parts[6]);
    const eod   = Number(parts[7]);
    if (!Number.isFinite(eod)) continue;
    rows.set(cusip, { bid, offer, eod });
  }
  return rows;
}

// Fetch a per-CUSIP series between fromDate and toDate by calling FedInvest
// once per business day. Returns rows in prices_daily shape. Prices are
// stored as per-$1 par (divide the per-$100 quote by 100) so they align with
// buyPrice (already stored per-$1 in transactions.price_native).
// In-request cache so backfilling N Treasury CUSIPs doesn't hit FedInvest
// N times for the same date — one HTTP call per business day is enough for
// the whole marketable universe. Reset per Node process (i.e. per Vercel
// serverless invocation).
const _fedInvestDayCache = new Map(); // ymd -> Promise<Map<cusip, quote> | null>
function fedInvestDay(ymd) {
  if (!_fedInvestDayCache.has(ymd)) {
    _fedInvestDayCache.set(ymd, fedInvestOne(ymd));
  }
  return _fedInvestDayCache.get(ymd);
}

async function fedInvestSeries(cusip, fromDate, toDate) {
  const out = [];
  const start = new Date(fromDate + 'T00:00:00Z');
  const end   = new Date(toDate   + 'T00:00:00Z');
  let cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const ymd = cur.toISOString().slice(0, 10);
    // eslint-disable-next-line no-await-in-loop
    const day = await fedInvestDay(ymd);
    if (day && day.has(cusip)) {
      const q = day.get(cusip);
      out.push({
        ticker: cusip,
        price_date: ymd,
        close_native: Number((q.eod / 100).toFixed(6)),
        currency: 'USD',
        source: 'fedinvest',
      });
    }
    cur = new Date(cur.getTime() + 86400000);
  }
  return out;
}

// ── Main entry: fetch a ticker for a date range using best source ──────────
async function fetchPriceSeries(ticker, fromDate, toDate, opts = {}) {
  if (isCusip(ticker)) {
    const t = opts.treasury || {};
    // Try FedInvest first (real market EOD by CUSIP). Fall back to the
    // straight-line synth curve when FedInvest returns no rows for the
    // requested window (e.g. the security isn't in the marketable universe).
    try {
      const real = await fedInvestSeries(ticker, fromDate, toDate);
      if (real.length) return real;
    } catch (_e) { /* fall through to synth */ }
    if (!t.buyDate || !t.buyPrice || !t.maturityDate) {
      throw new Error(`Treasury ${ticker}: no FedInvest data and missing opts.treasury (buyDate/buyPrice/maturityDate)`);
    }
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
  fedInvestSeries,
  fedInvestOne,
  ecbDaily,
  isCusip,
};
