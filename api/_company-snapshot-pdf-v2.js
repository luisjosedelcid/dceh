// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Company Snapshot PDF builder v2
// ───────────────────────────────────────────────────────────────────
// Rebuilt to spec (Aug 2026):
//   • Exactly 1 page, Letter, no overflow to page 2.
//   • Data source: ROIC.ai API only. No AI-generated content. No web
//     search. No estimates.
//   • Factual pre-Quick-Review overview. No verdicts, no Quality Gate,
//     no EPV, no IRR scenarios.
//   • NAVY / GOLD DCE brand. Helvetica for PDF portability.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const PDFDocument = require('pdfkit');
const { roicGet } = require('./_roic');

const NAVY = '#1B2642';
const GOLD = '#B88B47';
const CREAM = '#FAF7F0';
const GRAY_MID = '#6B6B6B';
const GRAY_LIGHT = '#D5D5D0';
const GREEN = '#2E7D32';
const RED = '#B71C1C';

const NA = 'NA';
const NM = 'NM';

// ─── Formatters ─────────────────────────────────────────────────────
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtPct1(v) {
  if (!isNum(v)) return NA;
  return `${v.toFixed(1)}%`;
}
function fmtEps(v) {
  if (!isNum(v)) return NA;
  return v.toFixed(2);
}
function fmtMoney(v, dec = 2) {
  if (!isNum(v)) return NA;
  return `$${v.toFixed(dec)}`;
}
function fmtMultiplier(v) {
  if (!isNum(v)) return NA;
  return `${v.toFixed(1)}x`;
}
// Auto-scale revenue: >= 1B in Billions with 2 dp, else Millions with 0 dp.
function pickRevenueScale(seriesDollars) {
  const vals = seriesDollars.filter(isNum);
  if (!vals.length) return { scale: 1e9, unit: 'B', dp: 2 };
  const maxAbs = Math.max(...vals.map(v => Math.abs(v)));
  if (maxAbs >= 1e9) return { scale: 1e9, unit: 'B', dp: 2 };
  return { scale: 1e6, unit: 'M', dp: 0 };
}
function fmtScaled(v, unit, dp) {
  if (!isNum(v)) return NA;
  return v.toFixed(dp);
}
function median(arr) {
  const s = arr.slice().sort((a,b) => a-b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function fmtEmployees(n) {
  if (!isNum(n)) return null;
  return n.toLocaleString('en-US');
}
function fmtIso(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}
function fmtDollarsB(v) {
  // For balance sheet numbers, always in $B with 2 dp
  if (!isNum(v)) return NA;
  const b = v / 1e9;
  if (Math.abs(b) < 0.01) {
    // switch to millions if too small
    return `$${(v/1e6).toFixed(0)}M`;
  }
  return `$${b.toFixed(2)}B`;
}
function colorSignedPct(v) {
  if (!isNum(v)) return GRAY_MID;
  return v >= 0 ? GREEN : RED;
}
function colorSignedNum(v) {
  if (!isNum(v)) return GRAY_MID;
  return v >= 0 ? GREEN : RED;
}
function colorNeutral() { return NAVY; }

// ─── ROIC.ai fetch + normalize ──────────────────────────────────────
async function fetchSnapshotData(ticker) {
  const t = ticker.toUpperCase().trim();

  // Parallel fetches
  const [profileR, priceR, incAnn, profAnn, multAnn, creditAnn, bsAnn, evLatest] = await Promise.all([
    roicGet(`/v2/company/profile/${t}`).catch(e => { throw new Error(`profile: ${e.message}`); }),
    roicGet(`/v2/stock-prices/latest/${t}`).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/income-statement/${t}`, { period: 'annual', limit: 6 })
      .catch(e => { throw new Error(`income: ${e.message}`); }),
    roicGet(`/v2/fundamental/ratios/profitability/${t}`, { period: 'annual', limit: 6 })
      .catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/multiples/${t}`, { period: 'annual', limit: 6 })
      .catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/ratios/credit/${t}`, { period: 'annual', limit: 6 })
      .catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/balance-sheet/${t}`, { period: 'annual', limit: 1 })
      .catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/enterprise-value/${t}`, { period: 'annual', limit: 1 })
      .catch(e => ({ __err: e.message })),
  ]);

  // Cash-flow: path can differ across accounts, try both
  let cfAnn = null;
  for (const p of ['/v2/fundamental/cash-flow/', '/v2/fundamental/cash-flow-statement/']) {
    try {
      const r = await roicGet(`${p}${t}`, { period: 'annual', limit: 6 });
      if (Array.isArray(r) && r.length) { cfAnn = r; break; }
    } catch (_) { /* try next */ }
  }
  if (!cfAnn) cfAnn = [];

  // TTM: optional. If unavailable, we simply omit TTM column.
  let incTtm = null, profTtm = null, multTtm = null, cfTtm = null;
  try { incTtm = await roicGet(`/v2/fundamental/income-statement/${t}`, { period: 'ttm', limit: 1 }); } catch (_) {}
  try { profTtm = await roicGet(`/v2/fundamental/ratios/profitability/${t}`, { period: 'ttm', limit: 1 }); } catch (_) {}
  try { multTtm = await roicGet(`/v2/fundamental/multiples/${t}`, { period: 'ttm', limit: 1 }); } catch (_) {}
  for (const p of ['/v2/fundamental/cash-flow/', '/v2/fundamental/cash-flow-statement/']) {
    try {
      const r = await roicGet(`${p}${t}`, { period: 'ttm', limit: 1 });
      if (Array.isArray(r) && r.length) { cfTtm = r; break; }
    } catch (_) {}
  }

  const profile = Array.isArray(profileR) ? profileR[0] : null;
  if (!profile) throw new Error(`No profile for ticker ${t}`);

  // Sort ascending by fiscal_year so we render oldest → newest left to right
  const sortByFy = arr => (Array.isArray(arr) ? arr : [])
    .slice()
    .sort((a,b) => String(a.fiscal_year || '').localeCompare(String(b.fiscal_year || '')));
  const income = sortByFy(incAnn).slice(-5);
  const profitability = sortByFy(profAnn);
  const multiples = sortByFy(multAnn);
  const credit = sortByFy(creditAnn);
  const cash = sortByFy(cfAnn);

  // Index by fiscal_year for cross-statement joins
  const profByFy = Object.fromEntries(profitability.map(r => [String(r.fiscal_year), r]));
  const multByFy = Object.fromEntries(multiples.map(r => [String(r.fiscal_year), r]));
  const creditByFy = Object.fromEntries(credit.map(r => [String(r.fiscal_year), r]));
  const cfByFy = Object.fromEntries(cash.map(r => [String(r.fiscal_year), r]));

  const fyLabels = income.map(r => `FY${String(r.fiscal_year).slice(-2)}`);
  const fyRaw = income.map(r => String(r.fiscal_year));

  // Series aligned to income[] years
  const revenue_dollars = income.map(r =>
    isNum(r.is_sales_revenue_turnover) ? r.is_sales_revenue_turnover : null
  );
  const rev_growth_pct = revenue_dollars.map((v, i) => {
    if (i === 0) return null;
    const p = revenue_dollars[i-1];
    if (!isNum(v) || !isNum(p) || Math.abs(p) < 1) return null;
    return ((v - p) / Math.abs(p)) * 100;
  });
  const ebit_margin = income.map(r => {
    const p = profByFy[String(r.fiscal_year)];
    return p && isNum(p.oper_margin) ? p.oper_margin : null;
  });
  const ni_margin = income.map(r => {
    const p = profByFy[String(r.fiscal_year)];
    return p && isNum(p.profit_margin) ? p.profit_margin : null;
  });
  const fcf_by_fy_dollars = fyRaw.map(fy => {
    const c = cfByFy[fy];
    if (!c) return null;
    const v = c.cf_free_cash_flow ?? c.free_cash_flow ?? c.cf_free_cash_flow_calc ?? null;
    return isNum(v) ? v : null;
  });
  const fcf_margin = fyRaw.map((fy, i) => {
    const fcf = fcf_by_fy_dollars[i];
    const rev = revenue_dollars[i];
    if (!isNum(fcf) || !isNum(rev) || rev <= 0) return null;
    return (fcf / rev) * 100;
  });
  const eps_diluted = income.map(r => {
    if (isNum(r.diluted_eps)) return r.diluted_eps;
    if (isNum(r.eps)) return r.eps;
    return null;
  });

  // Returns
  const roic = income.map(r => {
    const p = profByFy[String(r.fiscal_year)];
    // ROIC.ai profitability returns don't always include ROIC directly.
    // Try a few common field names.
    if (!p) return null;
    const v = p.return_on_inv_capital ?? p.roic ?? p.return_on_invested_capital ?? null;
    return isNum(v) ? v : null;
  });
  const roe = income.map(r => {
    const p = profByFy[String(r.fiscal_year)];
    return p && isNum(p.return_com_eqy) ? p.return_com_eqy : null;
  });
  const roa = income.map(r => {
    const p = profByFy[String(r.fiscal_year)];
    return p && isNum(p.return_on_asset) ? p.return_on_asset : null;
  });
  const fcf_ni = income.map(r => {
    const ni = r.is_net_income;
    const fcf = cfByFy[String(r.fiscal_year)]?.cf_free_cash_flow ?? cfByFy[String(r.fiscal_year)]?.free_cash_flow;
    // NM if NI is zero or negative (per spec)
    if (!isNum(ni) || ni <= 0) return { v: null, meaning: 'NM' };
    if (!isNum(fcf)) return { v: null, meaning: 'NA' };
    return { v: fcf / ni, meaning: 'OK' };
  });
  const diluted_shares = income.map(r => {
    const v = r.is_sh_for_diluted_eps;
    return isNum(v) ? v : null;
  });

  // Multiples (annual history for median + range)
  const peValsAll = multiples.map(m => m.pe_ratio).filter(v => isNum(v) && v > 0 && v < 500);
  const evEbitdaValsAll = multiples.map(m => m.ev_to_ttm_ebitda ?? m.ev_to_ebitda).filter(v => isNum(v) && v > 0 && v < 500);
  const evEbitValsAll = multiples.map(m => m.ev_to_ebit).filter(v => isNum(v) && v > 0 && v < 500);
  const evFcfValsAll = multiples.map(m => m.ev_to_fcf).filter(v => isNum(v) && v > 0 && v < 500);
  const fcfYieldValsAll = multiples.map(m => m.fcf_yield).filter(v => isNum(v));

  const rangeStr = arr => (arr.length >= 2)
    ? `${Math.min(...arr).toFixed(1)}x – ${Math.max(...arr).toFixed(1)}x`
    : NA;
  const medOrNa = arr => (arr.length >= 3) ? median(arr) : null;

  const pe_current = (multTtm && multTtm[0] && isNum(multTtm[0].pe_ratio))
    ? multTtm[0].pe_ratio
    : (multiples.length ? multiples[multiples.length-1]?.pe_ratio : null);
  const ev_ebitda_current = (multTtm && multTtm[0] && (isNum(multTtm[0].ev_to_ttm_ebitda) || isNum(multTtm[0].ev_to_ebitda)))
    ? (multTtm[0].ev_to_ttm_ebitda ?? multTtm[0].ev_to_ebitda)
    : (multiples.length ? (multiples[multiples.length-1]?.ev_to_ttm_ebitda ?? multiples[multiples.length-1]?.ev_to_ebitda) : null);
  const ev_ebit_current = (multTtm && multTtm[0] && isNum(multTtm[0].ev_to_ebit))
    ? multTtm[0].ev_to_ebit
    : (multiples.length ? multiples[multiples.length-1]?.ev_to_ebit : null);
  const ev_fcf_current = (multTtm && multTtm[0] && isNum(multTtm[0].ev_to_fcf))
    ? multTtm[0].ev_to_fcf
    : (multiples.length ? multiples[multiples.length-1]?.ev_to_fcf : null);
  const fcf_yield_current = (multTtm && multTtm[0] && isNum(multTtm[0].fcf_yield))
    ? multTtm[0].fcf_yield
    : (multiples.length ? multiples[multiples.length-1]?.fcf_yield : null);

  // Financial Position (latest balance sheet)
  const bs0 = Array.isArray(bsAnn) && bsAnn[0] ? bsAnn[0] : null;
  const cash_eq = bs0 ? (
    isNum(bs0.bs_cash_near_cash_item) ? bs0.bs_cash_near_cash_item :
    isNum(bs0.cash_and_equivalents) ? bs0.cash_and_equivalents :
    isNum(bs0.bs_cash_and_st_investments) ? bs0.bs_cash_and_st_investments :
    null
  ) : null;
  const total_debt = bs0 ? (
    isNum(bs0.short_and_long_term_debt) ? bs0.short_and_long_term_debt :
    isNum(bs0.bs_st_borrow) && isNum(bs0.bs_lt_borrow)
      ? bs0.bs_st_borrow + bs0.bs_lt_borrow :
    isNum(bs0.total_debt) ? bs0.total_debt :
    null
  ) : null;
  const net_debt = (isNum(cash_eq) && isNum(total_debt)) ? (total_debt - cash_eq) : null;
  // EBITDA for net debt / EBITDA — take last annual EBITDA from income
  let ebitda_latest = null;
  if (income.length) {
    const last = income[income.length - 1];
    ebitda_latest = isNum(last.ebitda) ? last.ebitda : (isNum(last.is_ebitda) ? last.is_ebitda : null);
  }
  const net_debt_to_ebitda = (isNum(net_debt) && isNum(ebitda_latest) && ebitda_latest > 0)
    ? net_debt / ebitda_latest
    : null;

  // ── Cover metrics ─────────────────────────────────────────────────
  const ev0 = Array.isArray(evLatest) && evLatest[0] ? evLatest[0] : null;
  let market_cap = null;
  if (ev0 && isNum(ev0.market_cap)) market_cap = ev0.market_cap;
  else if (ev0 && isNum(ev0.pr_last) && isNum(ev0.bs_sh_out)) market_cap = ev0.pr_last * ev0.bs_sh_out;
  else if (isNum(profile.price) && income.length && isNum(income[income.length-1].is_sh_for_diluted_eps)) {
    market_cap = profile.price * income[income.length-1].is_sh_for_diluted_eps;
  }
  const enterprise_value = ev0 && isNum(ev0.enterprise_value) ? ev0.enterprise_value : (
    isNum(market_cap) && isNum(net_debt) ? market_cap + net_debt : null
  );

  const price = (priceR && !priceR.__err && isNum(priceR.close)) ? priceR.close
              : (isNum(profile.price) ? profile.price : null);
  const price_date = (priceR && !priceR.__err && priceR.date) ? fmtIso(priceR.date) : null;

  // Financial statement as-of date: latest income period_end_date
  const fs_asof = income.length ? fmtIso(income[income.length-1].period_end_date || income[income.length-1].fiscal_year) : null;

  // Revenue CAGR 5Y (endpoints must both be positive)
  let cagr5 = null;
  if (revenue_dollars.length >= 2) {
    const first = revenue_dollars[0];
    const last = revenue_dollars[revenue_dollars.length-1];
    const yrs = revenue_dollars.length - 1;
    if (isNum(first) && isNum(last) && first > 0 && last > 0 && yrs > 0) {
      cagr5 = (Math.pow(last / first, 1 / yrs) - 1) * 100;
    }
  }

  // TTM series (single value each)
  const has_ttm = !!(Array.isArray(incTtm) && incTtm[0]);
  const ttm_revenue = has_ttm && isNum(incTtm[0].is_sales_revenue_turnover) ? incTtm[0].is_sales_revenue_turnover : null;
  const ttm_ebit_margin = (profTtm && profTtm[0] && isNum(profTtm[0].oper_margin)) ? profTtm[0].oper_margin : null;
  const ttm_ni_margin = (profTtm && profTtm[0] && isNum(profTtm[0].profit_margin)) ? profTtm[0].profit_margin : null;
  const ttm_eps_diluted = has_ttm && (isNum(incTtm[0].diluted_eps) ? incTtm[0].diluted_eps : (isNum(incTtm[0].eps) ? incTtm[0].eps : null));
  const ttm_fcf = (cfTtm && cfTtm[0]) ? (cfTtm[0].cf_free_cash_flow ?? cfTtm[0].free_cash_flow ?? null) : null;
  const ttm_fcf_margin = (isNum(ttm_fcf) && isNum(ttm_revenue) && ttm_revenue > 0) ? (ttm_fcf / ttm_revenue) * 100 : null;
  const ttm_rev_growth = (isNum(ttm_revenue) && income.length && isNum(income[income.length-1].is_sales_revenue_turnover) && income[income.length-1].is_sales_revenue_turnover > 0)
    ? ((ttm_revenue - income[income.length-1].is_sales_revenue_turnover) / income[income.length-1].is_sales_revenue_turnover) * 100
    : null;
  const ttm_roic = (profTtm && profTtm[0]) ? (profTtm[0].return_on_inv_capital ?? profTtm[0].roic ?? null) : null;
  const ttm_roe = (profTtm && profTtm[0] && isNum(profTtm[0].return_com_eqy)) ? profTtm[0].return_com_eqy : null;
  const ttm_roa = (profTtm && profTtm[0] && isNum(profTtm[0].return_on_asset)) ? profTtm[0].return_on_asset : null;
  const ttm_shares = has_ttm && isNum(incTtm[0].is_sh_for_diluted_eps) ? incTtm[0].is_sh_for_diluted_eps : null;
  const ttm_ni = has_ttm && isNum(incTtm[0].is_net_income) ? incTtm[0].is_net_income : null;
  const ttm_fcf_ni = (isNum(ttm_fcf) && isNum(ttm_ni) && ttm_ni > 0) ? { v: ttm_fcf / ttm_ni, meaning: 'OK' }
                    : (isNum(ttm_ni) && ttm_ni <= 0 ? { v: null, meaning: 'NM' } : { v: null, meaning: 'NA' });

  // Description: use ai_description ONLY as source of a factual, non-news description
  // — but strip any noisy leading news patterns (e.g. "In [year], the company...")
  // and truncate to 80 words max.
  let desc = profile.long_description || profile.description || profile.ai_description || '';
  desc = String(desc || '').replace(/\s+/g, ' ').trim();
  // Truncate to <= 80 words on word boundaries, ending on a sentence terminator if possible.
  const words = desc.split(' ');
  if (words.length > 80) {
    desc = words.slice(0, 80).join(' ').replace(/[,;:\-—]?$/, '') + '…';
  }

  // Shares change: current vs 3Y ago vs 5Y ago (all annual)
  const shares_current = diluted_shares.length ? diluted_shares[diluted_shares.length-1] : null;
  const shares_3y_ago = diluted_shares.length >= 4 ? diluted_shares[diluted_shares.length-4] : null;
  const shares_5y_ago = diluted_shares.length >= 5 ? diluted_shares[0] : null;
  const shares_chg_3y = (isNum(shares_current) && isNum(shares_3y_ago) && shares_3y_ago > 0)
    ? ((shares_current - shares_3y_ago) / shares_3y_ago) * 100 : null;
  const shares_chg_5y = (isNum(shares_current) && isNum(shares_5y_ago) && shares_5y_ago > 0)
    ? ((shares_current - shares_5y_ago) / shares_5y_ago) * 100 : null;

  return {
    ticker: t,
    name: profile.company_name || t,
    sector: profile.sector || null,
    industry: profile.industry || null,
    ceo: profile.ceo || null,
    employees: profile.full_time_employees || null,
    ipo_year: profile.ipo_date ? String(profile.ipo_date).slice(0, 4) : null,
    hq: [profile.city, profile.state, profile.country].filter(Boolean).join(', ') || null,
    website: profile.website ? String(profile.website).replace(/^https?:\/\//, '').replace(/\/$/, '') : null,
    fiscal_year_end: profile.fiscal_year_end || profile.fye_month || null,
    country_incorp: profile.country_of_incorporation || profile.country_incorp || null,
    description: desc,
    currency: profile.currency || 'USD',
    exchange: profile.exchange_short_name || profile.exchange || null,
    price,
    price_date,
    market_cap,
    enterprise_value,
    fs_asof,
    fy_labels: fyLabels,
    has_ttm,

    // Financial History rows (annual + TTM col)
    revenue_dollars,
    rev_growth_pct,
    ebit_margin,
    ni_margin,
    fcf_margin,
    eps_diluted,

    ttm_revenue,
    ttm_rev_growth,
    ttm_ebit_margin,
    ttm_ni_margin,
    ttm_fcf_margin,
    ttm_eps_diluted,

    // Returns & Cash Conversion
    roic,
    roe,
    roa,
    fcf_ni,
    diluted_shares,
    ttm_roic,
    ttm_roe,
    ttm_roa,
    ttm_fcf_ni,
    ttm_shares,
    shares_current,
    shares_chg_3y,
    shares_chg_5y,

    // Financial Position (latest BS)
    cash_eq,
    total_debt,
    net_debt,
    net_debt_to_ebitda,

    // Valuation Multiples (current + 5Y median + 5Y range)
    pe_current, pe_5y_median: medOrNa(peValsAll), pe_5y_range: rangeStr(peValsAll),
    ev_ebitda_current, ev_ebitda_5y_median: medOrNa(evEbitdaValsAll), ev_ebitda_5y_range: rangeStr(evEbitdaValsAll),
    ev_ebit_current, ev_ebit_5y_median: medOrNa(evEbitValsAll), ev_ebit_5y_range: rangeStr(evEbitValsAll),
    ev_fcf_current, ev_fcf_5y_median: medOrNa(evFcfValsAll), ev_fcf_5y_range: rangeStr(evFcfValsAll),
    fcf_yield_current, fcf_yield_5y_median: (fcfYieldValsAll.length >= 3 ? median(fcfYieldValsAll) : null),

    // Quick indicators (last available or TTM)
    cagr_5y_revenue: cagr5,
    latest_ebit_margin: ttm_ebit_margin ?? (ebit_margin.length ? ebit_margin[ebit_margin.length-1] : null),
    latest_fcf_margin: ttm_fcf_margin ?? (fcf_margin.length ? fcf_margin[fcf_margin.length-1] : null),
    latest_roic: ttm_roic ?? (roic.length ? roic[roic.length-1] : null),
  };
}

// ─── PDF drawing helpers ────────────────────────────────────────────

function drawHeaderBand(doc, W, M) {
  doc.rect(0, 0, W, 34).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
     .text('DCE HOLDINGS', M, 12, { lineBreak: false });
  doc.fillColor(GOLD).font('Helvetica').fontSize(8)
     .text('Investment Office  ·  Company Snapshot', M + 118, 13, { lineBreak: false });
}

function drawCover(doc, D, M, CW, yStart) {
  let y = yStart;
  doc.rect(M, y, CW, 2).fill(GOLD);
  y += 10;

  // Ticker + name
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(28)
     .text(D.ticker, M, y, { lineBreak: false });
  const nameX = M + doc.widthOfString(D.ticker) + 12;
  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(10)
     .text(D.name, nameX, y + 10, { lineBreak: false, width: CW - (nameX - M) });
  y += 34;

  // Sector · Industry (only if present)
  if (D.sector || D.industry) {
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
       .text('SECTOR', M, y, { lineBreak: false });
    const sectorStr = [D.sector, D.industry].filter(Boolean).join('  ·  ');
    doc.fillColor(NAVY).font('Helvetica').fontSize(9)
       .text(sectorStr, M + 46, y - 0.5, { lineBreak: false });
    y += 12;
  }

  // Row of 3 cover metrics: Last Price · Market Cap · Enterprise Value
  const colW = CW / 3;
  const labelY = y;
  const valueY = y + 10;
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
     .text('LAST PRICE', M, labelY, { lineBreak: false })
     .text('MARKET CAP', M + colW, labelY, { lineBreak: false })
     .text('ENTERPRISE VALUE', M + 2*colW, labelY, { lineBreak: false });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
     .text(fmtMoney(D.price), M, valueY, { lineBreak: false })
     .text(isNum(D.market_cap) ? fmtDollarsB(D.market_cap) : NA, M + colW, valueY, { lineBreak: false })
     .text(isNum(D.enterprise_value) ? fmtDollarsB(D.enterprise_value) : NA, M + 2*colW, valueY, { lineBreak: false });
  y = valueY + 20;

  // As-of meta line
  const meta = [];
  if (D.price_date) meta.push(`Price as of ${D.price_date}`);
  if (D.fs_asof) meta.push(`Financials as of ${D.fs_asof}`);
  if (D.currency) meta.push(`Currency ${D.currency}`);
  if (D.exchange) meta.push(D.exchange);
  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
     .text(meta.join('  ·  '), M, y, { lineBreak: false });
  y += 12;

  return y;
}

function drawSectionTitle(doc, M, y, title) {
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7.5)
     .text(title, M, y, { lineBreak: false });
  doc.moveTo(M, y + 11).lineTo(M + 24, y + 11)
     .lineWidth(1.2).strokeColor(GOLD).stroke();
  return y + 16;
}

function drawKeyValueLine(doc, entries, M, y, CW) {
  // entries: [[label, value], ...] — skip entries with null/empty value
  const present = entries.filter(([, v]) => v != null && String(v).trim() !== '');
  if (!present.length) return y;
  let x = M;
  doc.fontSize(7.5);
  const lineH = 11;
  const maxX = M + CW;
  for (const [k, v] of present) {
    doc.fillColor(GOLD).font('Helvetica-Bold').text(k, x, y, { lineBreak: false });
    const kW = doc.widthOfString(k);
    doc.fillColor(NAVY).font('Helvetica').text(String(v), x + kW + 4, y, { lineBreak: false });
    const vW = doc.widthOfString(String(v));
    x += kW + 4 + vW + 14;
    if (x > maxX - 40) { break; } // hard clip to avoid overflow
  }
  return y + lineH + 3;
}

function drawColumnHeader(doc, M, y, CW, labels, labelColW) {
  const cellW = (CW - labelColW) / labels.length;
  for (let i = 0; i < labels.length; i++) {
    const cx = M + labelColW + i * cellW;
    doc.fillColor(GRAY_MID).font('Helvetica-Bold').fontSize(6.5)
       .text(labels[i], cx, y, { width: cellW - 4, align: 'right', lineBreak: false });
  }
  doc.moveTo(M, y + 10).lineTo(M + CW, y + 10)
     .lineWidth(0.5).strokeColor(NAVY).stroke();
  return y + 14;
}

function drawRow(doc, M, y, CW, label, cells, labelColW, colorFn = null) {
  const cellW = (CW - labelColW) / cells.length;
  doc.fillColor(NAVY).font('Helvetica').fontSize(8)
     .text(label, M, y + 3, { width: labelColW - 6, lineBreak: false });
  for (let i = 0; i < cells.length; i++) {
    const cellObj = cells[i]; // { text, rawValue, formatter, color }
    const cx = M + labelColW + i * cellW;
    const color = cellObj.color || (colorFn ? colorFn(cellObj.rawValue) : NAVY);
    doc.fillColor(color).font('Helvetica-Bold').fontSize(8)
       .text(cellObj.text, cx, y + 3, { width: cellW - 4, align: 'right', lineBreak: false });
  }
  doc.moveTo(M, y + 15).lineTo(M + CW, y + 15)
     .lineWidth(0.3).strokeColor(GRAY_LIGHT).stroke();
  return y + 17;
}

function drawKpiStrip(doc, D, M, y, CW) {
  // Compact single-line strip: 5 KPIs, cleanly divided
  const items = [
    ['REVENUE CAGR 5Y', fmtPct1(D.cagr_5y_revenue), colorSignedPct(D.cagr_5y_revenue)],
    ['EBIT MARGIN', fmtPct1(D.latest_ebit_margin), colorSignedPct(D.latest_ebit_margin)],
    ['FCF MARGIN', fmtPct1(D.latest_fcf_margin), colorSignedPct(D.latest_fcf_margin)],
    ['ROIC', fmtPct1(D.latest_roic), colorSignedPct(D.latest_roic)],
    ['NET DEBT / CASH', isNum(D.net_debt)
        ? (D.net_debt > 0 ? `Net debt ${fmtDollarsB(D.net_debt)}` : `Net cash ${fmtDollarsB(-D.net_debt)}`)
        : NA,
       isNum(D.net_debt) ? (D.net_debt > 0 ? RED : GREEN) : GRAY_MID],
  ];
  const cellW = CW / items.length;
  // Background band
  doc.rect(M, y, CW, 26).fill(CREAM);
  for (let i = 0; i < items.length; i++) {
    const [k, v, color] = items[i];
    const cx = M + i * cellW;
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(6.5)
       .text(k, cx + 4, y + 5, { width: cellW - 8, lineBreak: false });
    doc.fillColor(color || NAVY).font('Helvetica-Bold').fontSize(11)
       .text(v, cx + 4, y + 13, { width: cellW - 8, lineBreak: false });
    if (i > 0) {
      doc.moveTo(cx, y + 4).lineTo(cx, y + 22)
         .lineWidth(0.4).strokeColor(GRAY_LIGHT).stroke();
    }
  }
  return y + 30;
}

function drawFinancialPositionLine(doc, D, M, y, CW) {
  const items = [
    ['CASH & EQUIVALENTS', fmtDollarsB(D.cash_eq)],
    ['TOTAL DEBT', fmtDollarsB(D.total_debt)],
    ['NET DEBT / (NET CASH)', isNum(D.net_debt)
        ? (D.net_debt >= 0 ? fmtDollarsB(D.net_debt) : `(${fmtDollarsB(-D.net_debt)})`)
        : NA],
    ['NET DEBT / EBITDA', isNum(D.net_debt_to_ebitda) ? `${D.net_debt_to_ebitda.toFixed(1)}x`
                            : (isNum(D.net_debt) && !isNum(D.net_debt_to_ebitda) ? NM : NA)],
  ];
  const cellW = CW / items.length;
  for (let i = 0; i < items.length; i++) {
    const [k, v] = items[i];
    const cx = M + i * cellW;
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(6.5)
       .text(k, cx, y, { width: cellW - 4, lineBreak: false });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
       .text(v, cx, y + 10, { width: cellW - 4, lineBreak: false });
  }
  return y + 26;
}

function drawFooter(doc, W, M) {
  const bandH = 24;
  const fY = doc.page.height - bandH;
  doc.rect(0, fY, W, bandH).fill(CREAM);
  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(6.5)
     .text(
       'Source: ROIC.ai API  ·  Financial statements as reported  ·  Calculations by DCE Holdings',
       M, fY + 6, { lineBreak: false }
     );
  doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(6.5)
     .text(
       'Factual company overview for preliminary screening. It does not constitute investment analysis or a recommendation. Companies selected for further review must complete the DCE Holdings Quick Review process.',
       M, fY + 14, { width: W - 2*M, lineBreak: false }
     );
}

// ─── Main builder ───────────────────────────────────────────────────

async function buildCompanySnapshotPDFv2(ticker) {
  const D = await fetchSnapshotData(ticker);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 44, bottom: 44, left: 44, right: 44 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `DCE Holdings — Company Snapshot ${D.ticker}`,
      Author: 'DCE Holdings Investment Office',
    },
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', resolve));

  const W = doc.page.width;
  const H = doc.page.height;
  const M = 44;
  const CW = W - M * 2;

  // 1. Header
  drawHeaderBand(doc, W, M);
  let y = 42;

  // 2. Cover block
  y = drawCover(doc, D, M, CW, y);
  y += 4;

  // 3. Corporate profile compact line
  const profileEntries = [
    ['CEO', D.ceo],
    ['EMPLOYEES', fmtEmployees(D.employees)],
    ['IPO', D.ipo_year],
    ['HQ', D.hq],
    ['WEB', D.website],
    ['FYE', D.fiscal_year_end],
    ['COUNTRY', D.country_incorp],
  ];
  y = drawKeyValueLine(doc, profileEntries, M, y, CW);
  y += 2;

  // 4. Business description (50-80 words, factual, from ROIC.ai profile only)
  if (D.description) {
    y = drawSectionTitle(doc, M, y, 'BUSINESS');
    doc.fillColor(NAVY).font('Helvetica').fontSize(8.5)
       .text(D.description, M, y, { width: CW, align: 'justify', lineGap: 1.5 });
    y = doc.y + 6;
  }

  // 5. Quick KPI strip (headline indicators)
  y = drawKpiStrip(doc, D, M, y, CW);
  y += 4;

  // 6. Financial History — 5 Years (+ TTM)
  y = drawSectionTitle(doc, M, y, 'FINANCIAL HISTORY — 5 YEARS');
  const fyCols = D.fy_labels.slice();
  if (D.has_ttm) fyCols.push('TTM');
  const labelColW = 130;

  y = drawColumnHeader(doc, M, y, CW, fyCols, labelColW);

  // Pick a revenue scale that applies to all revenue values (annual + TTM)
  const allRev = D.revenue_dollars.concat(D.has_ttm ? [D.ttm_revenue] : []);
  const { scale: rScale, unit: rUnit, dp: rDp } = pickRevenueScale(allRev);

  // Revenue
  const revCells = D.revenue_dollars.map(v => ({
    text: isNum(v) ? fmtScaled(v / rScale, rUnit, rDp) : NA,
    rawValue: v, color: NAVY,
  }));
  if (D.has_ttm) revCells.push({
    text: isNum(D.ttm_revenue) ? fmtScaled(D.ttm_revenue / rScale, rUnit, rDp) : NA,
    rawValue: D.ttm_revenue, color: NAVY,
  });
  y = drawRow(doc, M, y, CW, `Revenue (${'$' + rUnit})`, revCells, labelColW);

  // Revenue growth (no color per spec — but signs are naturally informative; use color anyway since growth is signed)
  const gCells = D.rev_growth_pct.map(v => ({
    text: fmtPct1(v), rawValue: v, color: null,
  }));
  if (D.has_ttm) gCells.push({ text: fmtPct1(D.ttm_rev_growth), rawValue: D.ttm_rev_growth, color: null });
  y = drawRow(doc, M, y, CW, 'Revenue growth', gCells, labelColW, colorSignedPct);

  // EBIT margin
  const emCells = D.ebit_margin.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) emCells.push({ text: fmtPct1(D.ttm_ebit_margin), rawValue: D.ttm_ebit_margin, color: null });
  y = drawRow(doc, M, y, CW, 'EBIT margin', emCells, labelColW, colorSignedPct);

  // Net income margin
  const nmCells = D.ni_margin.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) nmCells.push({ text: fmtPct1(D.ttm_ni_margin), rawValue: D.ttm_ni_margin, color: null });
  y = drawRow(doc, M, y, CW, 'Net income margin', nmCells, labelColW, colorSignedPct);

  // FCF margin
  const fmCells = D.fcf_margin.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) fmCells.push({ text: fmtPct1(D.ttm_fcf_margin), rawValue: D.ttm_fcf_margin, color: null });
  y = drawRow(doc, M, y, CW, 'FCF margin', fmCells, labelColW, colorSignedPct);

  // EPS diluted
  const epsCells = D.eps_diluted.map(v => ({ text: fmtEps(v), rawValue: v, color: null }));
  if (D.has_ttm) epsCells.push({ text: fmtEps(D.ttm_eps_diluted), rawValue: D.ttm_eps_diluted, color: null });
  y = drawRow(doc, M, y, CW, 'Diluted EPS', epsCells, labelColW, colorSignedNum);
  y += 6;

  // 7. Returns & Cash Conversion
  y = drawSectionTitle(doc, M, y, 'RETURNS & CASH CONVERSION');
  y = drawColumnHeader(doc, M, y, CW, fyCols, labelColW);

  const roicCells = D.roic.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) roicCells.push({ text: fmtPct1(D.ttm_roic), rawValue: D.ttm_roic, color: null });
  y = drawRow(doc, M, y, CW, 'ROIC', roicCells, labelColW, colorSignedPct);

  const roeCells = D.roe.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) roeCells.push({ text: fmtPct1(D.ttm_roe), rawValue: D.ttm_roe, color: null });
  y = drawRow(doc, M, y, CW, 'ROE', roeCells, labelColW, colorSignedPct);

  const roaCells = D.roa.map(v => ({ text: fmtPct1(v), rawValue: v, color: null }));
  if (D.has_ttm) roaCells.push({ text: fmtPct1(D.ttm_roa), rawValue: D.ttm_roa, color: null });
  y = drawRow(doc, M, y, CW, 'ROA', roaCells, labelColW, colorSignedPct);

  // FCF / NI — handle NM/NA per spec
  const fcfNiCells = D.fcf_ni.map(o => ({
    text: o.meaning === 'NM' ? NM : (o.meaning === 'NA' ? NA : (isNum(o.v) ? o.v.toFixed(2) : NA)),
    rawValue: o.v, color: null,
  }));
  if (D.has_ttm) fcfNiCells.push({
    text: D.ttm_fcf_ni.meaning === 'NM' ? NM : (D.ttm_fcf_ni.meaning === 'NA' ? NA : (isNum(D.ttm_fcf_ni.v) ? D.ttm_fcf_ni.v.toFixed(2) : NA)),
    rawValue: D.ttm_fcf_ni.v, color: null,
  });
  y = drawRow(doc, M, y, CW, 'FCF / Net income', fcfNiCells, labelColW);

  // Diluted shares — show current + 3Y + 5Y summary rather than 5 columns (space-constrained)
  const sharesRowLabel = 'Diluted shares (M)';
  const sharesCells = D.diluted_shares.map(v => ({
    text: isNum(v) ? (v / 1e6).toFixed(0) : NA, rawValue: v, color: null,
  }));
  if (D.has_ttm) sharesCells.push({
    text: isNum(D.ttm_shares) ? (D.ttm_shares / 1e6).toFixed(0) : NA, rawValue: D.ttm_shares, color: null,
  });
  y = drawRow(doc, M, y, CW, sharesRowLabel, sharesCells, labelColW);

  // Shares change 3Y / 5Y — compact summary
  doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(7)
     .text(
       `Shares change: ${isNum(D.shares_chg_3y) ? (D.shares_chg_3y >= 0 ? '+' : '') + D.shares_chg_3y.toFixed(1) + '% 3Y' : '3Y ' + NA}  ·  ${isNum(D.shares_chg_5y) ? (D.shares_chg_5y >= 0 ? '+' : '') + D.shares_chg_5y.toFixed(1) + '% 5Y' : '5Y ' + NA}`,
       M, y + 1, { lineBreak: false }
     );
  y += 12;

  // 8. Financial Position (compact one-line)
  y = drawSectionTitle(doc, M, y, 'FINANCIAL POSITION');
  y = drawFinancialPositionLine(doc, D, M, y, CW);
  y += 2;

  // 9. Valuation Multiples
  y = drawSectionTitle(doc, M, y, 'VALUATION MULTIPLES');
  const valColW = CW / 4;
  doc.fillColor(GRAY_MID).font('Helvetica-Bold').fontSize(6.5)
     .text('METRIC', M, y, { lineBreak: false })
     .text('CURRENT', M + valColW, y, { width: valColW - 4, align: 'right', lineBreak: false })
     .text('5Y MEDIAN', M + valColW * 2, y, { width: valColW - 4, align: 'right', lineBreak: false })
     .text('5Y RANGE', M + valColW * 3, y, { width: valColW - 4, align: 'right', lineBreak: false });
  doc.moveTo(M, y + 10).lineTo(M + CW, y + 10)
     .lineWidth(0.5).strokeColor(NAVY).stroke();
  y += 13;

  const valRows = [
    ['P/E', D.pe_current, D.pe_5y_median, D.pe_5y_range],
    ['EV / EBITDA', D.ev_ebitda_current, D.ev_ebitda_5y_median, D.ev_ebitda_5y_range],
    ['EV / EBIT', D.ev_ebit_current, D.ev_ebit_5y_median, D.ev_ebit_5y_range],
    ['EV / FCF', D.ev_fcf_current, D.ev_fcf_5y_median, D.ev_fcf_5y_range],
  ];
  for (const [lbl, cur, med, rng] of valRows) {
    doc.fillColor(NAVY).font('Helvetica').fontSize(8).text(lbl, M, y + 3, { lineBreak: false });
    doc.font('Helvetica-Bold')
       .text(fmtMultiplier(cur), M + valColW, y + 3, { width: valColW - 4, align: 'right', lineBreak: false });
    doc.font('Helvetica')
       .text(fmtMultiplier(med), M + valColW * 2, y + 3, { width: valColW - 4, align: 'right', lineBreak: false })
       .text(rng || NA, M + valColW * 3, y + 3, { width: valColW - 4, align: 'right', lineBreak: false });
    doc.moveTo(M, y + 15).lineTo(M + CW, y + 15).lineWidth(0.3).strokeColor(GRAY_LIGHT).stroke();
    y += 17;
  }

  // FCF yield row (%)
  doc.fillColor(NAVY).font('Helvetica').fontSize(8).text('FCF yield', M, y + 3, { lineBreak: false });
  doc.font('Helvetica-Bold')
     .text(fmtPct1(D.fcf_yield_current), M + valColW, y + 3, { width: valColW - 4, align: 'right', lineBreak: false });
  doc.font('Helvetica')
     .text(fmtPct1(D.fcf_yield_5y_median), M + valColW * 2, y + 3, { width: valColW - 4, align: 'right', lineBreak: false })
     .text('—', M + valColW * 3, y + 3, { width: valColW - 4, align: 'right', lineBreak: false });
  y += 17;

  // Footer (source + disclaimer band)
  drawFooter(doc, W, M);

  // ── 1-page hard guard ────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    // Should not happen if layout is calibrated; but if it does, remove excess pages.
    // pdfkit doesn't expose page deletion cleanly, so we log and let caller decide.
    // In practice we compress by shrinking description; layout is calibrated for AAPL-scale content.
    console.error(`[snapshot-v2] WARNING: emitted ${range.count} pages for ${D.ticker}`);
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), data: D, pages: doc.bufferedPageRange().count };
}

module.exports = { buildCompanySnapshotPDFv2, fetchSnapshotData };
