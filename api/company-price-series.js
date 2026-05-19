// ────────────────────────────────────────────────────────────────────────────
// Company Price Series — feeds the "Market Context" block in /company.html.
//
// Returns 5Y of daily closes from Yahoo Finance + the historical P/E TTM
// proxy series, using the EPS Diluted path stored in the company's dashboard
// JSON (financials.isRows row "EPS Diluted ($)" or financials.epsDiluted if
// emitted). For each close date, P/E = price / EPS_last_closed_FY.
//
// Query: /api/company-price-series?ticker=LULU&years=5
// ────────────────────────────────────────────────────────────────────────────

const { yahooDaily } = require('./_prices');
const { sbSelect } = require('./_supabase');
const fs = require('fs');
const path = require('path');

function ymd(d) { return new Date(d).toISOString().slice(0, 10); }

// Pull EPS Diluted history from the dashboard_json. Returns
// [{ fy: 'FY2020', eps: 5.0, periodEnd: '2021-01-31' }, ...] sorted by periodEnd.
function extractEpsHistory(json) {
  const fin = json && json.financials;
  if (!fin || !Array.isArray(fin.years)) return [];
  const years = fin.years;
  // Look up the EPS row in isRows
  let epsArr = null;
  if (Array.isArray(fin.isRows)) {
    const row = fin.isRows.find(r => r && /eps\s*dil/i.test(r.l || ''));
    if (row && Array.isArray(row.v)) epsArr = row.v;
  }
  // Fallback to fin.eps if present (some converters)
  if (!epsArr && Array.isArray(fin.eps)) epsArr = fin.eps;
  if (!epsArr) return [];

  // Approximate the fiscal year-end date. For LULU FY2025 ended 2026-02-02.
  // Generic heuristic: FY label "FYYYYY" → period end = Feb 1 of (YYYY+1).
  // Caller can override via overview.fiscalYearEnd (string description).
  // For chart purposes we just need monotone increasing dates.
  const out = [];
  for (let i = 0; i < years.length; i++) {
    const label = String(years[i] || '');
    const m = label.match(/(\d{4})/);
    if (!m) continue;
    const fyNum = parseInt(m[1], 10);
    // Convention used in DCE models: FY ends late Jan / early Feb of (fyNum+1)
    const periodEnd = `${fyNum + 1}-02-01`;
    const eps = Number(epsArr[i]);
    if (!isFinite(eps) || eps <= 0) continue;
    out.push({ fy: label, eps, periodEnd });
  }
  out.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return out;
}

// For each price date, find the EPS of the most recent FY ended on or before
// that date. Returns the same length as `dates` with null where no EPS yet.
function buildPePath(dates, prices, epsHistory) {
  const out = [];
  let idx = 0; // pointer into epsHistory
  let currentEps = null;
  for (let i = 0; i < dates.length; i++) {
    while (idx < epsHistory.length && epsHistory[idx].periodEnd <= dates[i]) {
      currentEps = epsHistory[idx].eps;
      idx++;
    }
    if (currentEps && prices[i] != null) {
      out.push(Number((prices[i] / currentEps).toFixed(2)));
    } else {
      out.push(null);
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const ticker = String((req.query && req.query.ticker) || '').toUpperCase().trim();
    const years  = Math.max(1, Math.min(10, parseInt((req.query && req.query.years) || '5', 10)));
    if (!ticker) {
      return res.status(400).json({ error: 'ticker required' });
    }

    // Look up dashboard json from Supabase (is_latest); fall back to public file.
    let dj = null;
    try {
      const rows = await sbSelect(
        'company_dashboards',
        `select=dashboard_json&ticker=eq.${ticker}&is_latest=is.true&limit=1`
      );
      if (rows && rows[0] && rows[0].dashboard_json) dj = rows[0].dashboard_json;
    } catch (e) {
      console.warn('[company-price-series] supabase lookup failed, falling back to file', e.message);
    }
    if (!dj) {
      const filePath = path.join(process.cwd(), 'public', 'companies', `${ticker.toLowerCase()}.json`);
      if (fs.existsSync(filePath)) {
        try { dj = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
      }
    }
    if (!dj) return res.status(404).json({ error: `no dashboard for ${ticker}` });

    // Determine finnhub/yahoo symbol (some companies require exchange suffix later)
    const yahooSym = dj.finnhubSymbol || dj.overview?.finnhubSymbol || ticker;

    // Date range: from = today - years; to = today
    const today = new Date();
    const from  = new Date(today.getTime() - years * 365.25 * 86400000);
    const series = await yahooDaily(yahooSym, ymd(from), ymd(today));
    // series = [{ price_date, close_native, ... }]
    const dates  = series.map(r => r.price_date);
    const prices = series.map(r => r.close_native);

    // EPS history → P/E path
    const epsHistory = extractEpsHistory(dj);
    const pe = buildPePath(dates, prices, epsHistory);

    // Reference levels for the price chart
    const ov = dj.overview || {};
    const epvPerShare    = Number(dj.epv?.epvPerShare) || null;
    const stockPriceSnap = Number(ov.stockPrice) || null;
    const valuationDate  = String(dj.valuationDate || '');
    // BUY zone: EPV × (1 − targetMoS). Default targetMoS = 22% (heuristic DCE).
    const targetMoS = Number(dj.adj?.targetMoS) || 0.22;
    const buyZone   = epvPerShare ? Number((epvPerShare * (1 - targetMoS)).toFixed(2)) : null;

    // P/E reference: median over the chart window
    const peClean = pe.filter(v => v != null && isFinite(v));
    peClean.sort((a, b) => a - b);
    const peMedian = peClean.length ? peClean[Math.floor(peClean.length / 2)] : null;
    const peCurrent = pe.length ? pe[pe.length - 1] : null;

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      ticker,
      yahooSymbol: yahooSym,
      yearsRequested: years,
      from: ymd(from),
      to: ymd(today),
      points: dates.length,
      dates,
      prices,
      pe,
      epsHistory,
      reference: {
        epvPerShare,
        stockPriceSnap,
        valuationDate,
        buyZone,
        targetMoS,
        peCurrent,
        peMedian,
      },
    });
  } catch (e) {
    console.error('[company-price-series]', e);
    return res.status(500).json({ error: e.message || 'internal error' });
  }
};
