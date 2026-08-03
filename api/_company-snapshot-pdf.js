// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Company Snapshot PDF builder
// ───────────────────────────────────────────────────────────────────
// Generates a 1-page branded snapshot PDF (NAVY/GOLD) from ROIC.ai
// fundamentals. Does NOT run Quality Gate, EPV, IRR scenarios or a
// routing verdict — that lives in the `dce-quick-review` v3.3 skill.
//
// Called from /api/company-snapshot.
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

// ─── Formatters ─────────────────────────────────────────────────────
function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}%`;
}
function fmtNum(v, dec = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(dec);
}
function fmtMoney(v, dec = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `$${v.toFixed(dec)}`;
}
function fmtMultiplier(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}x`;
}
function fmtBillions(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(2);
}
function colorForPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return GRAY_MID;
  return v >= 0 ? GREEN : RED;
}

// ─── ROIC.ai fetch + normalize ──────────────────────────────────────
// Returns null for a field if the API doesn't have it — never throws
// out of a missing metric, only out of a network / auth failure.

async function fetchSnapshotData(ticker) {
  const t = ticker.toUpperCase().trim();

  const [profileR, priceR, incomeR, profitR, multR] = await Promise.all([
    roicGet(`/v2/company/profile/${t}`).catch(e => { throw new Error(`profile: ${e.message}`); }),
    roicGet(`/v2/stock-prices/latest/${t}`).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/income-statement/${t}`, { period: 'annual', limit: 5 })
      .catch(e => { throw new Error(`income: ${e.message}`); }),
    roicGet(`/v2/fundamental/ratios/profitability/${t}`, { period: 'annual', limit: 5 })
      .catch(e => { throw new Error(`profitability: ${e.message}`); }),
    roicGet(`/v2/fundamental/multiples/${t}`, { period: 'annual', limit: 5 })
      .catch(e => { throw new Error(`multiples: ${e.message}`); }),
  ]);

  // Cash-flow needed for FCF/NI
  let cfR = null;
  try {
    cfR = await roicGet(`/v2/fundamental/cash-flow/${t}`, { period: 'annual', limit: 5 });
  } catch (_) { cfR = []; }

  // Enterprise value for market cap when profile.price is stale
  let evR = null;
  try {
    evR = await roicGet(`/v2/fundamental/enterprise-value/${t}`, { period: 'annual', limit: 1 });
  } catch (_) { evR = []; }

  const profile = Array.isArray(profileR) ? profileR[0] : null;
  if (!profile) throw new Error(`No profile for ticker ${t}`);

  // Sort ascending by fiscal_year so we render FY-4 → FY-0 left-to-right
  const income  = (Array.isArray(incomeR) ? incomeR : []).slice().sort((a,b) => String(a.fiscal_year).localeCompare(String(b.fiscal_year)));
  const profit  = (Array.isArray(profitR) ? profitR : []).slice().sort((a,b) => String(a.fiscal_year).localeCompare(String(b.fiscal_year)));
  const mult    = (Array.isArray(multR)   ? multR   : []).slice().sort((a,b) => String(a.fiscal_year).localeCompare(String(b.fiscal_year)));
  const cf      = (Array.isArray(cfR)     ? cfR     : []).slice().sort((a,b) => String(a.fiscal_year).localeCompare(String(b.fiscal_year)));

  // Fiscal-year labels (last 5)
  const fyLabels = income.map(r => `FY${String(r.fiscal_year).slice(-2)}`);

  // Series aligned to `income` order
  const revenue_b = income.map(r => (r.is_sales_revenue_turnover != null ? r.is_sales_revenue_turnover / 1e9 : null));
  const ebit_margin_pct = profit.map(r => (r.oper_margin != null ? r.oper_margin : null));
  const ni_margin_pct   = profit.map(r => (r.profit_margin != null ? r.profit_margin : null));
  const roe_pct         = profit.map(r => (r.return_com_eqy != null ? r.return_com_eqy : null));
  const roa_pct         = profit.map(r => (r.return_on_asset != null ? r.return_on_asset : null));
  const eps_diluted     = income.map(r => (r.diluted_eps != null ? r.diluted_eps : (r.eps != null ? r.eps : null)));

  // FCF/NI = free_cash_flow / net_income, joined by fiscal_year
  const niByFy  = Object.fromEntries(income.map(r => [String(r.fiscal_year), r.is_net_income]));
  const fcfByFy = Object.fromEntries(cf.map(r => [String(r.fiscal_year), r.cf_free_cash_flow ?? r.free_cash_flow ?? r.cf_free_cash_flow_calc ?? null]));
  const fcf_ni_ratio = income.map(r => {
    const ni = niByFy[String(r.fiscal_year)];
    const fcf = fcfByFy[String(r.fiscal_year)];
    if (ni && fcf && Math.abs(ni) > 1e6) return fcf / ni;
    return null;
  });

  // ── Valuation ─────────────────────────────────────────────────────
  const latestMult = mult.length ? mult[mult.length - 1] : null;
  const peValsAll  = mult.map(m => m.pe_ratio).filter(v => v != null && v > 0 && v < 500);
  const peBookValsAll = mult.map(m => m.pr_to_book_ratio).filter(v => v != null && v > 0);
  const evEbitdaValsAll = mult.map(m => m.ev_to_ttm_ebitda).filter(v => v != null && v > 0 && v < 500);

  const avg = arr => (arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : null);
  const minMax = arr => (arr.length ? [Math.min(...arr), Math.max(...arr)] : [null, null]);

  const pe_5y_avg = peValsAll.length >= 3 ? avg(peValsAll) : null;
  const [pe_5y_min, pe_5y_max] = minMax(peValsAll);
  const ev_5y_avg = evEbitdaValsAll.length >= 3 ? avg(evEbitdaValsAll) : null;
  const pb_5y_avg = peBookValsAll.length >= 3 ? avg(peBookValsAll) : null;

  // ── Market cap: prefer EV endpoint (has bs_sh_out × price), fall back to profile.price × shares ──
  let market_cap_b = null;
  if (Array.isArray(evR) && evR[0]) {
    const ev0 = evR[0];
    // enterprise-value endpoint returns market_cap sometimes; fall back to price × shares
    if (ev0.market_cap != null) market_cap_b = ev0.market_cap / 1e9;
    else if (ev0.pr_last != null && ev0.bs_sh_out != null) market_cap_b = (ev0.pr_last * ev0.bs_sh_out) / 1e9;
  }
  if (market_cap_b == null && profile.price != null && income.length && income[income.length-1].is_sh_for_diluted_eps != null) {
    market_cap_b = (profile.price * income[income.length-1].is_sh_for_diluted_eps) / 1e9;
  }

  const price     = (priceR && !priceR.__err && priceR.close != null) ? priceR.close : profile.price;
  const price_dp  = (priceR && !priceR.__err && priceR.change_percent != null) ? priceR.change_percent : null;
  const asOfDate  = (priceR && !priceR.__err && priceR.date) ? priceR.date : new Date().toISOString().slice(0,10);

  return {
    ticker: t,
    name: profile.company_name,
    sector: profile.sector || '—',
    industry: profile.industry || '—',
    ceo: profile.ceo || '—',
    employees: profile.full_time_employees || null,
    ipo_year: profile.ipo_date ? String(profile.ipo_date).slice(0,4) : '—',
    hq: [profile.city, profile.state, profile.country].filter(Boolean).join(', ') || '—',
    website: profile.website ? profile.website.replace(/^https?:\/\//,'').replace(/\/$/,'') : '—',
    // Prefer ai_description (structured) — fall back to description
    description: profile.ai_description || profile.description || '',
    currency: profile.currency || 'USD',
    exchange: profile.exchange_short_name || profile.exchange || '',
    price,
    price_change_pct: price_dp,
    market_cap_b,
    as_of_date: asOfDate,
    fiscal_years: fyLabels,
    revenue_b,
    ebit_margin_pct,
    ni_margin_pct,
    eps_diluted,
    roe_pct,
    roa_pct,
    fcf_ni_ratio,
    pe_current: latestMult ? latestMult.pe_ratio : null,
    pe_5y_avg,
    pe_5y_min,
    pe_5y_max,
    ev_ebitda_current: latestMult ? latestMult.ev_to_ttm_ebitda : null,
    ev_ebitda_5y_avg: ev_5y_avg,
    pb_current: latestMult ? latestMult.pr_to_book_ratio : null,
    pb_5y_avg,
  };
}

// ─── PDF layout ─────────────────────────────────────────────────────

function drawHeader(doc, W, M) {
  doc.rect(0, 0, W, 40).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
     .text('DCE HOLDINGS', M, 14, { lineBreak: false });
  doc.fillColor(GOLD).font('Helvetica').fontSize(9)
     .text('Investment Office  ·  Company Snapshot', M + 130, 15, { lineBreak: false });
}

function drawCoverBlock(doc, D, M, CW, y) {
  doc.rect(M, y, CW, 3).fill(GOLD);
  y += 14;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(36)
     .text(D.ticker, M, y, { lineBreak: false });
  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(11)
     .text(D.name, M + 130, y + 8, { lineBreak: false });
  y += 44;

  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text('SECTOR', M, y, { lineBreak: false });
  doc.fillColor(NAVY).font('Helvetica').fontSize(10)
     .text(`${D.sector}  ·  ${D.industry}`, M + 52, y - 1, { lineBreak: false });
  y += 16;

  const halfW = CW / 2;
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text('LAST PRICE', M, y, { lineBreak: false });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
     .text(fmtMoney(D.price), M, y + 12, { lineBreak: false });
  if (D.price_change_pct != null) {
    const chgColor = colorForPct(D.price_change_pct);
    doc.fillColor(chgColor).font('Helvetica').fontSize(9)
       .text(`${D.price_change_pct >= 0 ? '+' : ''}${D.price_change_pct.toFixed(2)}%`,
             M + 80, y + 16, { lineBreak: false });
  }

  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text('MARKET CAP', M + halfW, y, { lineBreak: false });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
     .text(D.market_cap_b != null ? `$${D.market_cap_b.toFixed(1)}B` : '—',
           M + halfW, y + 12, { lineBreak: false });

  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
     .text(`As of ${D.as_of_date}  ·  Currency ${D.currency}${D.exchange ? '  ·  '+D.exchange : ''}`,
           M, y + 34, { lineBreak: false });

  return y + 52;
}

function drawSectionTitle(doc, M, y, title) {
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text(title, M, y, { lineBreak: false });
  doc.moveTo(M, y + 14).lineTo(M + 30, y + 14)
     .lineWidth(1.5).strokeColor(GOLD).stroke();
  return y + 22;
}

function drawFyHeader(doc, M, y, CW, fyLabels) {
  const labelW = 160;
  const cellW = (CW - labelW) / fyLabels.length;
  for (let i = 0; i < fyLabels.length; i++) {
    const cx = M + labelW + i * cellW;
    doc.fillColor(GRAY_MID).font('Helvetica-Bold').fontSize(7)
       .text(fyLabels[i], cx, y, { width: cellW - 4, align: 'right', lineBreak: false });
  }
  doc.moveTo(M, y + 12).lineTo(M + CW, y + 12)
     .lineWidth(0.6).strokeColor(NAVY).stroke();
  return y + 16;
}

function drawSeriesRow(doc, M, y, CW, label, series, fyCount, formatter, colorFn) {
  const labelW = 160;
  const cellW = (CW - labelW) / fyCount;
  doc.fillColor(NAVY).font('Helvetica').fontSize(9)
     .text(label, M, y + 4, { width: labelW - 8, lineBreak: false });
  for (let i = 0; i < fyCount; i++) {
    const v = series[i];
    const cx = M + labelW + i * cellW;
    const color = colorFn ? colorFn(v) : NAVY;
    doc.fillColor(color).font('Helvetica-Bold').fontSize(9)
       .text(formatter(v), cx, y + 4, { width: cellW - 4, align: 'right', lineBreak: false });
  }
  doc.moveTo(M, y + 20).lineTo(M + CW, y + 20)
     .lineWidth(0.4).strokeColor(GRAY_LIGHT).stroke();
  return y + 22;
}

function drawValuationBlock(doc, D, M, y, CW) {
  y = drawSectionTitle(doc, M, y, 'VALUATION MULTIPLES');
  const colW = CW / 4;
  doc.fillColor(GRAY_MID).font('Helvetica-Bold').fontSize(7)
     .text('METRIC', M, y, { lineBreak: false })
     .text('CURRENT', M + colW, y, { width: colW - 4, align: 'right', lineBreak: false })
     .text('5Y AVG', M + colW * 2, y, { width: colW - 4, align: 'right', lineBreak: false })
     .text('5Y RANGE', M + colW * 3, y, { width: colW - 4, align: 'right', lineBreak: false });
  doc.moveTo(M, y + 12).lineTo(M + CW, y + 12)
     .lineWidth(0.6).strokeColor(NAVY).stroke();
  y += 18;

  const rangeStr = (a, b) => (a != null && b != null) ? `${fmtMultiplier(a)} – ${fmtMultiplier(b)}` : '—';
  const rows = [
    ['P/E', fmtMultiplier(D.pe_current), fmtMultiplier(D.pe_5y_avg), rangeStr(D.pe_5y_min, D.pe_5y_max)],
    ['EV / EBITDA', fmtMultiplier(D.ev_ebitda_current), fmtMultiplier(D.ev_ebitda_5y_avg), '—'],
    ['P / B', fmtMultiplier(D.pb_current), fmtMultiplier(D.pb_5y_avg), '—'],
  ];
  for (const row of rows) {
    doc.fillColor(NAVY).font('Helvetica').fontSize(9)
       .text(row[0], M, y + 4, { lineBreak: false })
       .font('Helvetica-Bold')
       .text(row[1], M + colW, y + 4, { width: colW - 4, align: 'right', lineBreak: false });
    doc.font('Helvetica')
       .text(row[2], M + colW * 2, y + 4, { width: colW - 4, align: 'right', lineBreak: false })
       .text(row[3], M + colW * 3, y + 4, { width: colW - 4, align: 'right', lineBreak: false });
    doc.moveTo(M, y + 20).lineTo(M + CW, y + 20)
       .lineWidth(0.4).strokeColor(GRAY_LIGHT).stroke();
    y += 22;
  }
  return y;
}

function drawFooter(doc, W, M) {
  const bandH = 28;
  const fY = doc.page.height - bandH;
  doc.rect(0, fY, W, bandH).fill(CREAM);
  doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
     .text(
       `CONFIDENTIAL  ·  DCE HOLDINGS  ·  Company Snapshot ${new Date().toISOString().slice(0, 10)}  ·  Does not replace Quick Review v3.3`,
       M, fY + 10, { lineBreak: false }
     );
}

// ─── Main builder ───────────────────────────────────────────────────

async function buildCompanySnapshotPDF(ticker) {
  const D = await fetchSnapshotData(ticker);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 60, bottom: 60, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: `DCE Holdings — Company Snapshot ${D.ticker}`,
      Author: 'DCE Holdings Investment Office',
    },
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', resolve));

  const W = doc.page.width;
  const M = 54;
  const CW = W - M * 2;
  const fyCount = D.fiscal_years.length;

  drawHeader(doc, W, M);
  let y = 60;
  y = drawCoverBlock(doc, D, M, CW, y);

  // Business description
  y = drawSectionTitle(doc, M, y, 'BUSINESS');
  if (D.description) {
    doc.fillColor(NAVY).font('Helvetica').fontSize(9)
       .text(D.description, M, y, { width: CW, align: 'justify', lineGap: 2 });
    y = doc.y + 10;
  }

  // Metadata line
  const meta = [
    ['CEO', D.ceo],
    ['EMPLOYEES', D.employees != null ? D.employees.toLocaleString() : '—'],
    ['IPO', D.ipo_year],
    ['HQ', D.hq],
    ['WEB', D.website],
  ];
  let mx = M;
  for (const [k, v] of meta) {
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7).text(k, mx, y, { lineBreak: false });
    const kW = doc.widthOfString(k);
    doc.fillColor(NAVY).font('Helvetica').fontSize(8).text(String(v), mx + kW + 4, y - 0.5, { lineBreak: false });
    mx += kW + 4 + doc.widthOfString(String(v)) + 18;
  }
  y += 20;

  // Growth
  y = drawSectionTitle(doc, M, y, `GROWTH — ${fyCount} YEARS`);
  y = drawFyHeader(doc, M, y, CW, D.fiscal_years);
  y = drawSeriesRow(doc, M, y, CW, 'Revenue ($B)',        D.revenue_b,       fyCount, v => fmtBillions(v), null);
  y = drawSeriesRow(doc, M, y, CW, 'EBIT margin',         D.ebit_margin_pct, fyCount, fmtPct, colorForPct);
  y = drawSeriesRow(doc, M, y, CW, 'Net Income margin',   D.ni_margin_pct,   fyCount, fmtPct, colorForPct);
  y = drawSeriesRow(doc, M, y, CW, 'EPS diluted ($)',     D.eps_diluted,     fyCount, v => fmtNum(v, 2), colorForPct);
  y += 8;

  // Quality
  y = drawSectionTitle(doc, M, y, `QUALITY — ${fyCount} YEARS`);
  y = drawFyHeader(doc, M, y, CW, D.fiscal_years);
  y = drawSeriesRow(doc, M, y, CW, 'ROE',      D.roe_pct,       fyCount, fmtPct, colorForPct);
  y = drawSeriesRow(doc, M, y, CW, 'ROA',      D.roa_pct,       fyCount, fmtPct, colorForPct);
  y = drawSeriesRow(doc, M, y, CW, 'FCF / NI', D.fcf_ni_ratio,  fyCount, v => fmtNum(v, 2), null);
  y += 8;

  // Valuation
  y = drawValuationBlock(doc, D, M, y, CW);
  y += 12;

  // Scope note
  doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(8)
     .text(
       'This snapshot is a factual view of ROIC.ai fundamentals with DCE branding. It does not compute Quality Gate, EPV, IRR scenarios or a routing verdict. Run the full Quick Review v3.3 skill for those.',
       M, y, { width: CW, align: 'left' }
     );

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawFooter(doc, W, M);
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), data: D };
}

module.exports = { buildCompanySnapshotPDF };
