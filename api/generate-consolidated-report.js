// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Consolidated Snapshot PDF (Vercel serverless)
// ───────────────────────────────────────────────────────────────────
// Server-side replica of the Consolidated tab in /performance.html.
// Aggregates the 5 sleeves (Equity, Cash & Equivalents, Fixed Income,
// Real Estate, Crypto) into a single one-page branded PDF.
//
// Data sources (server-side, mirrors what the browser does):
//   - Equity engine       → loadAndCompute() from _perf-load
//     (with fast=1 default: skips Finnhub overlay + pending divs to
//      dodge the Vercel Hobby 504 window)
//   - Real Estate         → public/real_estate_positions.json
//   - Crypto              → public/crypto_positions.json
//                           (uses static NAV; no live price fetch)
//   - Time Deposits (CDs) → loadAndValueTimeDeposits() from _time-deposits
//
// Structure mirrors the DOM of tab-consolidado:
//   1) KPI strip: NAV total, Capital, Total P&L, MOIC, Consolidated TWR
//   2) Allocation-by-sleeve table (5 rows + TOTAL)
//   3) IPS §3.1 strategic bands (6 rows + illiquidity cap)
//   4) Top consolidated holdings (up to 10 rows)
//
// GET /api/generate-consolidated-report  →  application/pdf
// Query params:
//   ?debug=1  → returns phase-timing JSON instead of PDF (diagnostic)
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs   = require('fs');
const PDFDocument = require('pdfkit');
const { loadAndCompute } = require('./_perf-load');
const { loadAndValueTimeDeposits } = require('./_time-deposits');
const { valueCryptoLive } = require('./_crypto-prices');
const { requireRole } = require('./_require-role');
const {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtUSD0Signed, fmtPct, fmtPctRaw, fmtMoic, pctColor,
  drawHeaderBar, drawFooter, drawSectionLabel, drawHeroCell,
} = require('./_pdf-helpers');

// Read a public/*.json file synchronously. Vercel bundles /public into the
// deployment output so require('fs') can read from the project root.
function readPublicJson(filename) {
  try {
    const p = path.join(process.cwd(), 'public', filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Wrap a promise in a hard timeout so one slow dep can't wedge the whole PDF.
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, r) => setTimeout(() => r(new Error(`${label}_timeout_${ms}ms`)), ms)),
]);

function yearsBetween(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    let debugMode = false;
    try {
      const u = new URL(req.url, 'http://x');
      debugMode = u.searchParams.get('debug') === '1';
    } catch (_) {}
    const dbg = { phases: {} };

    // ── 1) Load all sleeves in parallel ─────────────────────────────
    const t0 = Date.now();
    const [eqResult, tdResult] = await Promise.all([
      withTimeout(loadAndCompute({}), 30_000, 'loadAndCompute').catch(e => ({ _err: e.message })),
      withTimeout(loadAndValueTimeDeposits(new Date().toISOString().slice(0, 10)), 8_000, 'timeDeposits').catch(e => ({ _err: e.message })),
    ]);
    dbg.phases.loadAll_ms = Date.now() - t0;
    dbg.phases.equity_err = eqResult?._err || null;
    dbg.phases.td_err = tdResult?._err || null;

    const reJson = readPublicJson('real_estate_positions.json');
    const crJson = readPublicJson('crypto_positions.json');
    dbg.phases.re_loaded = !!reJson;
    dbg.phases.cr_loaded = !!crJson;

    // ── 2) Reduce each sleeve to a small set of numbers ─────────────
    // -- Equity engine (Equity + T-bills + Cash uninvested) --
    const eqK = eqResult && !eqResult._err ? eqResult.kpis : null;
    const eqHoldings = (eqResult && !eqResult._err && Array.isArray(eqResult.holdings)) ? eqResult.holdings : [];
    let eqNav = 0, eqCap = 0, eqPnlUnr = 0, eqLast = '—', eqTwr = null;
    let eqMvEquity = 0, eqMvFixedIncome = 0, eqMvCashEquiv = 0, eqCashUsd = 0;
    if (eqK) {
      eqNav = Number(eqK.nav || 0);
      eqCap = Number(eqK.invested_usd || 0);
      eqPnlUnr = Number(eqK.unrealized_pnl || 0);
      eqLast = eqK.last_date || '—';
      eqMvEquity = Number(eqK.mv_equity_usd || 0);
      eqMvFixedIncome = Number(eqK.mv_fixed_income_usd || 0);
      eqMvCashEquiv = Number(eqK.mv_cash_equivalent_usd || 0);
      eqCashUsd = Number(eqK.cash_usd || 0);
      if (eqK.twr_cum_pct != null) eqTwr = Number(eqK.twr_cum_pct);
    }
    const eqEquityNav = eqMvEquity;
    const eqFixedIncomeNav = eqMvFixedIncome;
    const cashNav = eqCashUsd + eqMvCashEquiv;

    // -- Time Deposits (bank CDs) --
    let tdPrincipal = 0, tdMv = 0, tdAccruedNet = 0, tdCount = 0;
    if (tdResult && !tdResult._err && Array.isArray(tdResult.deposits)) {
      for (const td of tdResult.deposits) {
        tdPrincipal += Number(td.principal || 0);
        tdMv        += Number(td.mv || 0);
        tdAccruedNet += Number(td.accrued_net || 0);
        tdCount++;
      }
    }
    const fixedIncomeNav = eqFixedIncomeNav + tdMv;

    // -- Real Estate --
    let reNav = 0, reCap = 0, reLast = '—', reTwr = null;
    const reEnriched = [];
    if (reJson) {
      const fxToday = Number(reJson.fx_eur_usd?.today || 0);
      const todayD = new Date();
      for (const p of (reJson.positions || [])) {
        const fxDeploy = Number(p.fx_eur_usd_at_deploy || 0);
        const costUsd = Number(p.amount_eur || 0) * fxDeploy;
        const navUsd = Number(p.nav_eur || 0) * fxToday;
        reEnriched.push({ name: p.name, costUsd, navUsd });
        reCap += costUsd;
        reNav += navUsd;
      }
      reLast = reJson.nav_as_of || '—';
      if (reCap > 0) reTwr = reNav / reCap - 1;
    }
    const rePnlUnr = reNav - reCap;

    // -- Crypto (fetches CoinGecko live spot; falls back to static NAV) --
    let crNav = 0, crCap = 0, crPnlUnr = 0, crPnlRealized = 0, crPnlTotal = 0, crLast = '—', crTwr = null;
    let crEnriched = [];
    let crPriceSource = 'static';
    if (crJson) {
      crCap = Number(crJson.capital?.capital_neto_aportado_usd || 0);
      const t1 = Date.now();
      const liveResult = await valueCryptoLive(crJson, 4000);
      dbg.phases.crypto_live_ms = Date.now() - t1;
      dbg.phases.crypto_price_source = liveResult.priceSource;
      dbg.phases.crypto_stale_reason = liveResult.staleReason || null;
      crNav = liveResult.crNav;
      crEnriched = liveResult.crEnriched;
      crLast = liveResult.asOfDate;
      crPriceSource = liveResult.priceSource;
      const costTotal = (crJson.positions || []).reduce((s, p) => s + Number(p.cost_basis_total_usd || 0), 0);
      crPnlUnr = crNav - costTotal;
      crPnlRealized = Number(crJson.realized_pnl_historico?.neto_usd || 0);
      crPnlTotal = crPnlRealized + crPnlUnr;
      if (crCap > 0) crTwr = (crNav + crPnlRealized) / crCap - 1;
    }

    // -- Totals --
    const totNav = eqNav + reNav + crNav + tdMv;
    const totCap = eqCap + reCap + crCap + tdPrincipal;
    // Header defines MOIC as NAV/Capital — keep it consistent with that
    // definition. Historical realized crypto P&L is reported separately in the
    // reconciliation block below (it was already withdrawn from NAV).
    const totMoic = totCap > 0 ? totNav / totCap : null;
    // Headline Total P&L reconciles exactly against NAV − Capital. The sum of
    // sleeve P&L may differ; the difference is decomposed below into three
    // explicit adjustments so the identity is fully auditable.
    const sumSleevePnl = eqPnlUnr + rePnlUnr + crPnlTotal + tdAccruedNet;
    const navMinusCap = totNav - totCap;
    const totPnlUnr = navMinusCap; // headline P&L

    // === Reconciliation decomposition ================================
    // Identity we want to expose:
    //   sum(sleeve_P&L) + adjustments = NAV − Capital
    //
    // Each adjustment maps a sleeve's reported P&L into the (NAV−Capital)
    // frame. Positive value → the sleeve under-reports economic value; add.
    // Negative value → sleeve over-reports; subtract.
    //
    // (A) Crypto capital-basis adjustment. The sleeve reports
    //         crPnlTotal = crPnlUnr + crPnlRealized
    //     but NAV − Capital for Crypto in the consolidated frame is
    //         (crNav − crCap)
    //     where crCap is *net* contributed capital (deposits − withdrawals
    //     already returned to bank). The realized historical P&L moved to
    //     bank via those withdrawals, so it cancels out with the withdrawals
    //     leg of crCap — the residual is the small ledger drift between
    //     cost basis and net capital.
    const adjCrypto = (crNav - crCap) - crPnlTotal;
    // (B) Equity capital-basis: Schwab avg-cost vs. our net-cash Capital.
    const adjEquity = (eqNav - eqCap) - eqPnlUnr;
    // (C) Real Estate residual: NAV − Capital already equals unrealized P&L
    //     for RE, so this should be zero — kept for symmetry.
    const adjRealEstate = (reNav - reCap) - rePnlUnr;
    // (D) Fixed income (bank CDs) residual: MV − Principal vs. accrued_net.
    const adjFixedIncome = (tdMv - tdPrincipal) - tdAccruedNet;
    // (E) Combined marketable adjustment (Equity + FI + Cash residuals). Cash
    //     residual is absorbed by the Equity engine because they share the
    //     Schwab account.
    const adjMarketableCostBasis = adjEquity + adjRealEstate + adjFixedIncome;
    const otherAdjustments = navMinusCap - sumSleevePnl; // total delta

    // Sleeve count (each sub-sleeve of the Equity engine only counts if NAV > 0)
    const sleeveCount = (eqK && eqEquityNav > 0 ? 1 : 0)
                      + (fixedIncomeNav > 0 ? 1 : 0)
                      + (eqK && cashNav > 0 ? 1 : 0)
                      + (reJson ? 1 : 0) + (crJson ? 1 : 0);

    // Weighted-avg consolidated TWR
    const tdConsolTwr = tdPrincipal > 0 ? tdAccruedNet / tdPrincipal : null;
    let twrNumer = 0, twrWeights = 0;
    if (eqTwr != null && eqNav > 0)  { twrNumer += eqTwr * eqNav; twrWeights += eqNav; }
    if (reTwr != null && reNav > 0)  { twrNumer += reTwr * reNav; twrWeights += reNav; }
    if (crTwr != null && crNav > 0)  { twrNumer += crTwr * crNav; twrWeights += crNav; }
    if (tdConsolTwr != null && tdMv > 0) { twrNumer += tdConsolTwr * tdMv; twrWeights += tdMv; }
    const totTwr = twrWeights > 0 ? twrNumer / twrWeights : null;

    // Debug probe short-circuits here.
    if (debugMode) {
      dbg.phases.totals = { totNav, totCap, totPnlUnr, totTwr };
      dbg.phases.total_ms = Date.now() - t0;
      res.status(200).json(dbg);
      return;
    }

    // ── 3) Build PDF ────────────────────────────────────────────────
    const asOfDate = new Date().toISOString().slice(0, 10);
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `DCE Holdings — Consolidated Snapshot ${asOfDate}`,
        Author: 'DCE Holdings Investment Office',
      },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));

    const W = doc.page.width;
    const M = 54;
    const CW = W - M * 2;

    drawHeaderBar(doc, 'Consolidated Snapshot');

    // ─── TITLE ───────────────────────────────────────────────────
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('DCE HOLDINGS — INVESTMENT OFFICE', M, 70, { characterSpacing: 1.5 });
    doc.moveTo(M, 88).lineTo(M + 16, 88).strokeColor(GOLD).lineWidth(1).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(24)
       .text('Consolidated Snapshot', M, 96);
    const asOfPretty = new Date(asOfDate + 'T00:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    doc.fillColor(GRAY).font('Helvetica').fontSize(10)
       .text(`As of ${asOfPretty}  ·  ${sleeveCount} active ${sleeveCount === 1 ? 'sleeve' : 'sleeves'}  ·  Consolidated portfolio`, M, 130);
    // Staleness warning: flag any sleeve valued > 7 days before the report date
    const asOfMs = new Date(asOfDate + 'T00:00:00Z').getTime();
    const staleSleeves = [];
    const checkStale = (label, isoDate) => {
      if (!isoDate || isoDate === '\u2014') return;
      const t = Date.parse(isoDate);
      if (isNaN(t)) return;
      const daysOld = Math.floor((asOfMs - t) / (86400 * 1000));
      if (daysOld > 7) staleSleeves.push(`${label}: ${daysOld}d`);
    };
    checkStale('Real Estate', reLast);
    checkStale('Crypto', crLast);
    if (staleSleeves.length > 0) {
      doc.fillColor(RED).font('Helvetica-Oblique').fontSize(8.5)
         .text(`Stale valuations: ${staleSleeves.join(' \u00b7 ')}. Consolidated NAV mixes valuation dates \u2014 see \u201cLast update\u201d column.`, M, 145, { width: CW });
    }

    // ─── HERO METRICS ────────────────────────────────────────────
    let y = 160;
    doc.rect(M, y, CW, 90).fill(WHITE).strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.rect(M, y, CW, 2).fill(GOLD);

    const totRoi = totCap > 0 ? totPnlUnr / totCap : null;
    const heroCells = [
      { label: 'NAV TOTAL (USD)',        value: fmtUSD(totNav, 0),         sub: `${sleeveCount} sleeves active`,     subColor: GRAY },
      { label: 'NET CONTRIBUTED CAPITAL', value: fmtUSD(totCap, 0),         sub: 'cash in \u2212 cash out',                subColor: GRAY },
      { label: 'TOTAL P&L (USD)',         value: fmtUSD0Signed(totPnlUnr),  sub: `NAV \u2212 Capital`,                        valueColor: pctColor(totPnlUnr), subColor: GRAY },
      { label: 'CONSOLIDATED MOIC',       value: fmtMoic(totMoic),          sub: 'NAV / Capital',                     valueColor: (totMoic != null && totMoic >= 1) ? GREEN : RED, subColor: GRAY },
      { label: 'P&L / CAPITAL',           value: fmtPct(totRoi),            sub: 'Simple cumulative return',          valueColor: pctColor(totRoi),    subColor: GRAY },
    ];
    const cellW = CW / heroCells.length;
    heroCells.forEach((cell, i) => {
      drawHeroCell(doc, cell, M + i * cellW, y, cellW, 90);
      if (i > 0) {
        doc.moveTo(M + i * cellW, y + 12).lineTo(M + i * cellW, y + 78).strokeColor(LIGHT).lineWidth(0.5).stroke();
      }
    });

    y += 90 + 20;

    // ─── ALLOCATION BY SLEEVE ────────────────────────────────────
    drawSectionLabel(doc, y, 'Allocation by sleeve');
    y += 16;

    // Cosmetic split for the Equity engine sub-sleeves (Equity / T-bills / Cash)
    const eqMvTotal = eqEquityNav + eqFixedIncomeNav + cashNav;
    const eqEquityShare      = eqMvTotal > 0 ? eqEquityNav      / eqMvTotal : 0;
    const eqFixedIncomeShare = eqMvTotal > 0 ? eqFixedIncomeNav / eqMvTotal : 0;
    const cashShare          = eqMvTotal > 0 ? cashNav          / eqMvTotal : 0;
    const eqEquityCap      = eqCap * eqEquityShare;
    const eqFixedIncomeCap = eqCap * eqFixedIncomeShare;
    const cashCap          = eqCap * cashShare;
    const eqEquityPnl      = eqPnlUnr * eqEquityShare;
    const eqFixedIncomePnl = eqPnlUnr * eqFixedIncomeShare;
    const cashPnl          = eqPnlUnr * cashShare;
    const fixedIncomeCap = eqFixedIncomeCap + tdPrincipal;
    const fixedIncomePnl = eqFixedIncomePnl + tdAccruedNet;
    const tdTwr = tdPrincipal > 0 ? tdAccruedNet / tdPrincipal : null;
    let fiTwr = null;
    if (fixedIncomeNav > 0) {
      let n = 0, d = 0;
      if (eqTwr != null && eqFixedIncomeNav > 0) { n += eqTwr * eqFixedIncomeNav; d += eqFixedIncomeNav; }
      if (tdTwr != null && tdMv > 0)             { n += tdTwr * tdMv;             d += tdMv; }
      fiTwr = d > 0 ? n / d : null;
    }
    const fiLast = (tdResult && tdResult.as_of) ? tdResult.as_of : eqLast;

    const sleeves = [
      { label: 'Equity',              nav: eqEquityNav,     cap: eqEquityCap,      pnl: eqEquityPnl,   twr: eqTwr,  last: eqLast, present: !!eqK && eqEquityNav > 0 },
      { label: 'Fixed Income',        nav: fixedIncomeNav,  cap: fixedIncomeCap,   pnl: fixedIncomePnl,twr: fiTwr,  last: fiLast, present: fixedIncomeNav > 0 },
      { label: 'Cash & Equivalents',  nav: cashNav,         cap: cashCap,          pnl: cashPnl,       twr: eqTwr,  last: eqLast, present: !!eqK && cashNav > 0 },
      { label: 'Real Estate',         nav: reNav,           cap: reCap,            pnl: rePnlUnr,      twr: reTwr,  last: reLast, present: !!reJson },
      { label: 'Crypto',              nav: crNav,           cap: crCap,            pnl: crPnlTotal,    twr: crTwr,  last: crLast, present: !!crJson, realized: crPnlRealized },
    ];

    // Table layout
    const cols = [
      { key: 'label', w: 110, align: 'left',  title: 'Sleeve' },
      { key: 'nav',   w: 68,  align: 'right', title: 'NAV (USD)' },
      { key: 'pct',   w: 44,  align: 'right', title: '% NAV' },
      { key: 'cap',   w: 68,  align: 'right', title: 'Capital' },
      { key: 'pnl',   w: 65,  align: 'right', title: 'P&L' },
      { key: 'moic',  w: 36,  align: 'right', title: 'MOIC' },
      { key: 'twr',   w: 48,  align: 'right', title: 'Ret. cum.' },
      { key: 'last',  w: 65,  align: 'left',  title: 'Last update' },
    ];
    // Draw header row
    doc.rect(M, y, CW, 18).fill(NAVY);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8);
    let cx = M + 6;
    for (const col of cols) {
      doc.text(col.title, cx, y + 5, { width: col.w - 4, align: col.align, lineBreak: false });
      cx += col.w;
    }
    y += 18;

    doc.font('Helvetica').fontSize(8.5).fillColor(NEAR_BLACK);
    let rowIdx = 0;
    for (const s of sleeves) {
      if (!s.present) continue;
      const rowH = 16;
      if (rowIdx % 2 === 1) doc.rect(M, y, CW, rowH).fill(ROW_ALT);
      const wNav = totNav > 0 ? s.nav / totNav : 0;
      // MOIC = NAV / Capital (consistent with header definition). Realized
      // historical P&L for Crypto is disclosed in the reconciliation block.
      const moic = s.cap > 0 ? s.nav / s.cap : null;

      cx = M + 6;
      const cells = [
        { text: s.label, color: NAVY, bold: true },
        { text: fmtUSD(s.nav, 0), color: NEAR_BLACK },
        { text: fmtPctRaw(wNav), color: NEAR_BLACK },
        { text: fmtUSD(s.cap, 0), color: NEAR_BLACK },
        { text: fmtUSD0Signed(s.pnl), color: pctColor(s.pnl), bold: true },
        { text: fmtMoic(moic), color: (moic != null && moic >= 1) ? GREEN : RED, bold: true },
        { text: fmtPct(s.twr), color: pctColor(s.twr), bold: true },
        { text: s.last, color: GRAY },
      ];
      cells.forEach((cell, i) => {
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(cell.color).fontSize(8.5)
           .text(cell.text, cx, y + 4, { width: cols[i].w - 4, align: cols[i].align, lineBreak: false, ellipsis: true });
        cx += cols[i].w;
      });
      y += rowH;
      rowIdx++;
    }
    // TOTAL row
    doc.rect(M, y, CW, 18).fill(CREAM);
    cx = M + 6;
    const totalCells = [
      { text: 'TOTAL',              color: NAVY, align: 'left' },
      { text: fmtUSD(totNav, 0),    color: NAVY, align: 'right' },
      { text: '100.00%',            color: NAVY, align: 'right' },
      { text: fmtUSD(totCap, 0),    color: NAVY, align: 'right' },
      { text: fmtUSD0Signed(totPnlUnr), color: pctColor(totPnlUnr), align: 'right' },
      { text: fmtMoic(totMoic),     color: (totMoic != null && totMoic >= 1) ? GREEN : RED, align: 'right' },
      { text: fmtPct(totRoi),       color: pctColor(totRoi), align: 'right' },
      { text: '',                   color: NAVY, align: 'left' },
    ];
    totalCells.forEach((cell, i) => {
      doc.font('Helvetica-Bold').fillColor(cell.color).fontSize(9)
         .text(cell.text, cx, y + 5, { width: cols[i].w - 4, align: cell.align, lineBreak: false });
      cx += cols[i].w;
    });
    y += 18 + 8;
    // Reconciliation footnote: sum(sleeve P&L) + adjustments = NAV − Capital
    if (Math.abs(otherAdjustments) >= 1) {
      const parts = [];
      parts.push(`Reported sleeve P&L ${fmtUSD0Signed(sumSleevePnl)}`);
      if (Math.abs(adjCrypto) >= 1)               parts.push(`Crypto capital-basis adjustment ${fmtUSD0Signed(adjCrypto)}`);
      if (Math.abs(adjMarketableCostBasis) >= 1)  parts.push(`Marketable portfolio cost-basis/timing ${fmtUSD0Signed(adjMarketableCostBasis)}`);
      parts.push(`Consolidated P&L ${fmtUSD0Signed(navMinusCap)}`);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(GRAY)
         .text(`Reconciliation: ${parts.join('  \u00b7  ')}`,
           M, y, { width: CW });
      y += 22;
    } else {
      y += 10;
    }

    // ─── IPS §3.1 STRATEGIC BANDS ────────────────────────────────
    drawSectionLabel(doc, y, 'IPS §3.1 — Strategic allocation bands');
    y += 16;

    const bands = [
      { label: 'Public equities',            min: 0.50, max: 0.80, actual: totNav > 0 ? eqMvEquity / totNav : 0 },
      { label: 'Private equity',             min: 0.00, max: 0.20, actual: 0 },
      { label: 'Real estate',                min: 0.00, max: 0.20, actual: totNav > 0 ? reNav / totNav : 0 },
      { label: 'Fixed income',               min: 0.05, max: 0.15, actual: totNav > 0 ? fixedIncomeNav / totNav : 0 },
      { label: 'Cash & equivalents',         min: 0.15, max: 0.25, actual: totNav > 0 ? cashNav / totNav : 0 },
      { label: 'Alternatives (incl. Crypto)',min: 0.00, max: 0.15, actual: totNav > 0 ? crNav / totNav : 0 },
    ];
    const ipsCols = [
      { w: 220, align: 'left',  title: 'Asset class' },
      { w: 60,  align: 'right', title: 'Min' },
      { w: 60,  align: 'right', title: 'Max' },
      { w: 65,  align: 'right', title: 'Actual' },
      { w: CW - 220 - 60 - 60 - 65, align: 'left', title: 'Status' },
    ];
    doc.rect(M, y, CW, 16).fill(NAVY);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8);
    cx = M + 6;
    for (const c of ipsCols) {
      doc.text(c.title, cx, y + 4, { width: c.w - 4, align: c.align, lineBreak: false });
      cx += c.w;
    }
    y += 16;

    doc.font('Helvetica').fontSize(8);
    let ipsIdx = 0;
    for (const b of bands) {
      const rowH = 14;
      if (ipsIdx % 2 === 1) doc.rect(M, y, CW, rowH).fill(ROW_ALT);
      let status, color;
      // Band status: hard bands per IPS §3.1. Order matters:
      //   1. Above max → hard breach, ABOVE max.
      //   2. Below min → hard breach, BELOW min.
      //   3. Exactly at min (0% floor, e.g. Private Equity at 0/0-20)
      //      or exactly at max → boundary but not a warning: OK.
      //   4. Strictly inside the band and within 200 bps of an edge
      //      that is > 0 → Near limit (soft warning).
      //   5. Otherwise → OK.
      const tol = 0.02;
      if (b.actual > b.max) {
        status = 'ABOVE max'; color = RED;
      } else if (b.actual < b.min) {
        status = 'BELOW min'; color = RED;
      } else {
        const nearMin = b.min > 0 && b.actual < b.min + tol;
        const nearMax = b.actual > b.max - tol && b.actual < b.max;
        if (nearMin || nearMax) { status = 'Near limit'; color = GOLD; }
        else { status = 'OK \u2014 within band'; color = GREEN; }
      }
      cx = M + 6;
      const row = [
        { text: b.label,                                     color: NEAR_BLACK, align: 'left'  },
        { text: (b.min * 100).toFixed(0) + '%',              color: NEAR_BLACK, align: 'right' },
        { text: (b.max * 100).toFixed(0) + '%',              color: NEAR_BLACK, align: 'right' },
        { text: (b.actual * 100).toFixed(2) + '%',           color: NAVY,       align: 'right', bold: true },
        { text: status,                                      color: color,      align: 'left',  bold: true },
      ];
      row.forEach((cell, i) => {
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(cell.color).fontSize(8)
           .text(cell.text, cx, y + 3, { width: ipsCols[i].w - 4, align: cell.align, lineBreak: false });
        cx += ipsCols[i].w;
      });
      y += rowH;
      ipsIdx++;
    }
    // Illiquidity row
    const illiq = totNav > 0 ? reNav / totNav : 0;
    let ilqStatus, ilqColor;
    if (illiq <= 0.50)      { ilqStatus = 'OK — within band'; ilqColor = GREEN; }
    else if (illiq <= 0.52) { ilqStatus = 'Near limit';       ilqColor = GOLD; }
    else                    { ilqStatus = 'ABOVE max';         ilqColor = RED; }
    doc.rect(M, y, CW, 14).fill(CREAM);
    cx = M + 6;
    const ilqRow = [
      { text: 'Consolidated illiquidity (max)', color: NAVY, align: 'left', bold: true, italic: true },
      { text: '—',                              color: NAVY, align: 'right' },
      { text: '50%',                            color: NAVY, align: 'right' },
      { text: (illiq * 100).toFixed(2) + '%',   color: NAVY, align: 'right', bold: true },
      { text: ilqStatus,                        color: ilqColor, align: 'left', bold: true },
    ];
    ilqRow.forEach((cell, i) => {
      const font = cell.italic ? 'Helvetica-Oblique' : (cell.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.font(font).fillColor(cell.color).fontSize(8)
         .text(cell.text, cx, y + 3, { width: ipsCols[i].w - 4, align: cell.align, lineBreak: false });
      cx += ipsCols[i].w;
    });
    y += 14 + 16;

    // ─── TOP CONSOLIDATED HOLDINGS ───────────────────────────────
    drawSectionLabel(doc, y, 'Top consolidated holdings');
    y += 16;

    const allHoldings = [];
    for (const h of eqHoldings) {
      const mv = Number(h.market_value || h.marketValue || h.mv || 0);
      const name = h.ticker || h.symbol || h.name || '?';
      if (mv > 0) {
        const ac = h.asset_class || 'equity';
        let sleeveLabel = 'Equity';
        if (ac === 'fixed_income')     sleeveLabel = 'Fixed Income';
        else if (ac === 'cash_equivalent') sleeveLabel = 'Cash & Equivalents';
        allHoldings.push({ sleeve: sleeveLabel, name, mv });
      }
    }
    for (const r of reEnriched) {
      if (r.navUsd > 0) allHoldings.push({ sleeve: 'Real Estate', name: r.name, mv: r.navUsd });
    }
    for (const c of crEnriched) {
      if (c.marketUsd > 0) allHoldings.push({ sleeve: 'Crypto', name: c.name, mv: c.marketUsd });
    }
    if (tdResult && !tdResult._err && Array.isArray(tdResult.deposits)) {
      for (const td of tdResult.deposits) {
        const mv = Number(td.mv || 0);
        if (mv > 0) {
          const bank = td.bank || td.counterparty || 'Bank';
          const tenor = td.tenor_days ? ` (${td.tenor_days}d)` : '';
          allHoldings.push({ sleeve: 'Fixed Income', name: `CD ${bank}${tenor}`, mv });
        }
      }
    }
    allHoldings.sort((a, b) => b.mv - a.mv);
    const topN = allHoldings.slice(0, 10);

    const topCols = [
      { w: 130, align: 'left',  title: 'Sleeve' },
      { w: CW - 130 - 130 - 90, align: 'left', title: 'Holding' },
      { w: 130, align: 'right', title: 'Market value (USD)' },
      { w: 90,  align: 'right', title: '% Total NAV' },
    ];
    doc.rect(M, y, CW, 16).fill(NAVY);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8);
    cx = M + 6;
    for (const c of topCols) {
      doc.text(c.title, cx, y + 4, { width: c.w - 4, align: c.align, lineBreak: false });
      cx += c.w;
    }
    y += 16;

    doc.font('Helvetica').fontSize(8.5).fillColor(NEAR_BLACK);
    topN.forEach((h, i) => {
      const rowH = 14;
      if (i % 2 === 1) doc.rect(M, y, CW, rowH).fill(ROW_ALT);
      const pctNav = totNav > 0 ? h.mv / totNav : 0;
      cx = M + 6;
      const cells = [
        { text: h.sleeve,                    color: NAVY,        align: 'left', bold: true },
        { text: h.name,                       color: NEAR_BLACK,  align: 'left' },
        { text: fmtUSD(h.mv, 0),              color: NEAR_BLACK,  align: 'right' },
        { text: (pctNav * 100).toFixed(2) + '%', color: NEAR_BLACK, align: 'right' },
      ];
      cells.forEach((cell, j) => {
        doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(cell.color).fontSize(8.5)
           .text(cell.text, cx, y + 3, { width: topCols[j].w - 4, align: cell.align, lineBreak: false, ellipsis: true });
        cx += topCols[j].w;
      });
      y += rowH;
    });

    // Footer
    drawFooter(doc, asOfDate, 'portfolio_snapshots + real_estate + crypto + time_deposits');
    doc.end();
    await done;

    const buf = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="DCE_Consolidated_Snapshot_${asOfDate}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(buf);
  } catch (err) {
    console.error('[generate-consolidated-report] fatal:', err);
    res.status(500).json({ error: err.message || 'Failed to build consolidated PDF' });
  }
};
