// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Performance Snapshot PDF (Vercel serverless)
// ───────────────────────────────────────────────────────────────────
// Generates a branded one-page snapshot of the Performance dashboard.
// Reads the SAME source as /api/performance (loadAndCompute) so the PDF
// is 100% consistent with what the user sees on /performance.html.
//
// Includes:
//   - Hero metrics: NAV, TWR vs S&P 500, IRR (XIRR), Max DD
//   - Holdings table: ticker, qty, avg cost, last price, MV, unrealized P&L,
//     IRR (annualized), weight, days held
//   - Cash · Market Value · Realized P&L · Unrealized P&L cards
//   - Dividends + Interest · Withholding tax cards
//   - Equity curve TWR vs S&P 500 (line chart, last 180 days or full history)
//
// GET /api/generate-daily-report  →  application/pdf
// ═══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { loadAndCompute } = require('./_perf-load');
const { computePendingDividends } = require('./dividend-pending');
const { finnhubQuote } = require('./_prices');
const { requireRole } = require('./_require-role');

// Apply Finnhub live quotes on top of snapshot holdings (mirrors public/performance.html liveOverlay).
// Mutates kpis + holdings in place and returns true if any update was applied.
async function applyLiveOverlay(kpis, holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return false;
  const tickerRe = /^[A-Z][A-Z0-9.\-]{0,9}$/;
  const eligible = holdings.filter(h => h.ticker && tickerRe.test(h.ticker));
  if (eligible.length === 0) return false;

  const quotes = await Promise.all(eligible.map(async (h) => {
    try {
      const q = await finnhubQuote(h.ticker);
      if (!q || !isFinite(q.close_native) || q.close_native <= 0) return null;
      return { ticker: h.ticker, price: q.close_native };
    } catch (_) { return null; }
  }));

  let anyUpdated = false;
  let liveTotalMv = 0;
  let liveTotalUnrealized = 0;

  for (let i = 0; i < eligible.length; i++) {
    const h = eligible[i];
    const live = quotes[i];
    if (!live) {
      if (h.market_value != null) liveTotalMv += h.market_value;
      if (h.unrealized_pnl != null) liveTotalUnrealized += h.unrealized_pnl;
      continue;
    }
    anyUpdated = true;
    const newMv = h.qty * live.price;
    const newPnl = newMv - (h.cost_basis || 0);
    h.last_price = live.price;
    h.market_value = newMv;
    h.unrealized_pnl = newPnl;
    if (h.days_held && h.cost_basis > 0 && newMv > 0) {
      const years = h.days_held / 365;
      if (years > 0) h.irr_annualized = Math.pow(newMv / h.cost_basis, 1/years) - 1;
    }
    liveTotalMv += newMv;
    liveTotalUnrealized += newPnl;
  }

  // Add non-eligible holdings (CUSIPs etc.) at their snapshot values
  for (const h of holdings) {
    if (eligible.find(e => e.ticker === h.ticker)) continue;
    if (h.market_value != null) liveTotalMv += h.market_value;
    if (h.unrealized_pnl != null) liveTotalUnrealized += h.unrealized_pnl;
  }

  // Rebalance per-holding weights against new total
  if (anyUpdated && liveTotalMv > 0) {
    for (const h of holdings) {
      if (h.market_value != null) h.weight_pct = h.market_value / liveTotalMv;
    }
  }

  if (anyUpdated) {
    const oldMv = kpis.market_value_usd || 0;
    kpis.market_value_usd = liveTotalMv;
    kpis.unrealized_pnl = liveTotalUnrealized;
    kpis.nav = (kpis.cash_usd || 0) + liveTotalMv;
    kpis.total_pnl_usd = (kpis.realized_pnl || 0) + liveTotalUnrealized;
    if ((kpis.invested_usd || 0) > 0) {
      kpis.total_return_pct = kpis.total_pnl_usd / kpis.invested_usd;
    }
    kpis.live_overlay_applied = true;
  }
  return anyUpdated;
}

// Brand colors
const NAVY = '#1b2642';
const GOLD = '#b88b47';
const GRAY = '#606060';
const LIGHT = '#e6e6e6';
const GREEN = '#1f5f3f';
const RED   = '#7a1010';
const NEAR_BLACK = '#0d0d0d';
const WHITE = '#ffffff';
const ROW_ALT = '#fafaf7';

// ─── Formatting helpers ────────────────────────────────────────────
function fmtUSD(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    maximumFractionDigits: digits, minimumFractionDigits: digits,
  }).format(n);
}
function fmtUSDSigned(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  // Use ASCII '-' (not Unicode minus U+2212) — the bundled Helvetica AFM
  // in pdfkit doesn't ship the U+2212 glyph and renders it as a tofu.
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${fmtUSD(Math.abs(n), 2)}`;
}
function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = n * 100;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}
function fmtPctRaw(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtNum(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function pctColor(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return NEAR_BLACK;
  return n >= 0 ? GREEN : RED;
}

// ─── PDF helpers ───────────────────────────────────────────────────
function drawHeaderBar(doc) {
  const W = doc.page.width;
  doc.rect(0, 0, W, 40).fill(NAVY);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11)
     .text('DCE HOLDINGS  ·  INVESTMENT OFFICE', 54, 14, { lineBreak: false });
  doc.fillColor(GOLD).font('Helvetica').fontSize(9)
     .text('Performance Snapshot', 54, 14, { width: W - 108, align: 'right' });
}

function drawFooter(doc, asOfDate) {
  // Pin everything to absolute coordinates within page bounds.
  // LETTER height = 792pt. Footer occupies last ~40pt.
  const pageH = doc.page.height;
  const pageW = doc.page.width;
  const lineY = pageH - 42;
  const txt1Y = pageH - 32;
  const txt2Y = pageH - 18;

  doc.moveTo(54, lineY).lineTo(pageW - 54, lineY).strokeColor(GOLD).lineWidth(0.5).stroke();

  doc.fillColor(GRAY).font('Helvetica').fontSize(7)
     .text(
       `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  ·  As of close ${asOfDate}  ·  Source: portfolio_snapshots + transactions + cashflows`,
       54, txt1Y,
       { width: pageW - 108, height: 10, lineBreak: false, ellipsis: true }
     );
  doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
     .text(
       'DCE Holdings Investment Office — Confidential · Internal use only',
       54, txt2Y,
       { width: pageW - 108, height: 10, lineBreak: false, ellipsis: true }
     );
}

function drawSectionLabel(doc, y, label) {
  doc.fillColor(GOLD).font('Helvetica').fontSize(8)
     .text(`— ${label.toUpperCase()}`, 54, y, { characterSpacing: 1.4 });
}

// ─── IPS tactical bands (§3.5–3.7) ─────────────────────────────────
function drawIpsBands(doc, x, y, w, h, kpis) {
  // Same thresholds and asset-class classification as renderIpsBands() in performance.html.
  // Cash sleeve = account cash + cash-equivalent ETFs (SGOV, BIL, ...).
  // Equity sleeve = only true equity holdings (excludes SGOV & T-bill CUSIPs).
  // Fixed income sleeve = T-bill CUSIPs, CDs, other fixed-income holdings.
  const nav        = Number((kpis && kpis.nav) || 0);
  const cash       = Number((kpis && kpis.cash_usd) || 0);
  const mvEquity   = Number((kpis && kpis.mv_equity_usd) || 0);
  const mvFixedInc = Number((kpis && kpis.mv_fixed_income_usd) || 0);
  const mvCashEq   = Number((kpis && kpis.mv_cash_equivalent_usd) || 0);

  const cashSleevePct  = nav > 0 ? (cash + mvCashEq) / nav : 0;
  const equityPct      = nav > 0 ? mvEquity / nav : 0;
  const fixedIncomePct = nav > 0 ? mvFixedInc / nav : 0;

  const BANDS = [
    { label: 'Cash / equivalents',      min: 0.15, max: 0.25, value: cashSleevePct },
    { label: 'Equity — quality',         min: 0.60, max: 0.80, value: equityPct },
    { label: 'Equity — special sit',     min: 0.00, max: 0.15, value: 0 },
    { label: 'Fixed income',            min: 0.00, max: 0.10, value: fixedIncomePct },
  ];

  // Frame
  doc.rect(x, y, w, h).fill(WHITE).strokeColor(LIGHT).lineWidth(0.5).stroke();

  // Column layout (relative to x)
  const padX = 14, padY = 12;
  const colLabel = x + padX;
  const colBand  = x + 200;
  const colReading = x + 280;
  const colBarStart = x + 340;
  const colBarEnd = x + w - 90;
  const colStatus = x + w - 70;

  // Header row
  let yy = y + padY;
  doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(7)
     .text('CATEGORÍA', colLabel, yy, { characterSpacing: 1.2, lineBreak: false });
  doc.text('BANDA', colBand, yy, { characterSpacing: 1.2, lineBreak: false });
  doc.text('LECTURA', colReading, yy, { characterSpacing: 1.2, lineBreak: false });
  doc.text('POSICIÓN RELATIVA', colBarStart, yy, { characterSpacing: 1.2, lineBreak: false });
  doc.text('ESTADO', colStatus, yy, { characterSpacing: 1.2, lineBreak: false });
  yy += 14;
  doc.lineWidth(0.5).strokeColor(LIGHT).moveTo(x + padX, yy).lineTo(x + w - padX, yy).stroke();
  yy += 8;

  const rowH = (h - padY - 30) / BANDS.length;

  BANDS.forEach((b, idx) => {
    const reading = b.value;
    const inBand = reading >= b.min && reading <= b.max;
    const bandLabel = b.min === b.max
      ? (b.min * 100).toFixed(0) + '%'
      : (b.min * 100).toFixed(0) + '–' + (b.max * 100).toFixed(0) + '%';
    const readingTxt = (reading * 100).toFixed(1) + '%';

    const rowY = yy + idx * rowH;
    const textY = rowY + 4;

    // Label
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(9.5)
       .text(b.label, colLabel, textY, { width: 180, lineBreak: false });

    // Band
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(bandLabel, colBand, textY, { lineBreak: false });

    // Reading
    doc.fillColor(NEAR_BLACK).font('Helvetica-Bold').fontSize(10)
       .text(readingTxt, colReading, textY - 0.5, { lineBreak: false });

    // Range bar
    const barY = rowY + 10;
    const barH = 5;
    const barW = colBarEnd - colBarStart;
    const domainMax = Math.max(b.max + 0.10, reading + 0.05, 0.30);
    const xAt = (v) => colBarStart + (v / domainMax) * barW;
    // Background track
    doc.rect(colBarStart, barY, barW, barH).fill(LIGHT);
    // In-band region (pale gold)
    const bMinX = xAt(b.min);
    const bMaxX = xAt(b.max);
    doc.rect(bMinX, barY, bMaxX - bMinX, barH).fill('#e8d9b4');
    // Reading marker
    const rX = Math.min(Math.max(xAt(reading), colBarStart), colBarEnd);
    const markerColor = inBand ? GREEN : RED;
    doc.rect(rX - 1, barY - 2, 2, barH + 4).fill(markerColor);
    // 0% / domainMax tick labels
    doc.fillColor(GRAY).font('Helvetica').fontSize(6.5)
       .text('0%', colBarStart, barY + barH + 2, { width: 20, lineBreak: false });
    doc.text((domainMax * 100).toFixed(0) + '%', colBarEnd - 18, barY + barH + 2, { width: 20, align: 'right', lineBreak: false });

    // Status badge
    const badgeColor = inBand ? GREEN : RED;
    const badgeTxt = inBand ? 'EN BANDA' : 'FUERA';
    const badgeW = 56, badgeH = 14;
    doc.roundedRect(colStatus, textY - 2, badgeW, badgeH, 2).fill(badgeColor);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7.5)
       .text(badgeTxt, colStatus, textY + 1.5, { width: badgeW, align: 'center', characterSpacing: 0.6, lineBreak: false });
  });

  // Footer note
  const footerY = y + h - 12;
  doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
     .text('Current allocation vs IPS bands §3.5–3.7 · Benchmark: S&P 500 (SPY)', x + padX, footerY, { width: w - padX * 2, lineBreak: false });
}

module.exports = async (req, res) => {
  try {
    // Portfolio PDF — require any authenticated user (same bar as /api/performance).
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    // Parse optional ?as_of=YYYY-MM-DD to generate the snapshot for a past date.
    // Default: today (loadAndCompute clamps to the latest available data).
    let requestedAsOf = null;
    let debugMode = false;
    let fastMode = false;
    let traceMode = false;
    try {
      const u = new URL(req.url, 'http://x');
      const v = (u.searchParams.get('as_of') || '').trim();
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        requestedAsOf = v;
      }
      debugMode = u.searchParams.get('debug') === '1';
      // ?fast=1 skips Finnhub live overlay + pending-dividends network calls.
      // Snapshot data alone is fine for a portfolio PDF; the extra network hops
      // are what push us into 504-territory on Vercel Hobby's shrinking limits.
      fastMode = u.searchParams.get('fast') === '1';
      // ?trace=1 wraps every PDF drawing section in a try/catch that logs
      // its elapsed time. If a section throws, we return the trace as JSON
      // instead of a half-broken PDF so we can pinpoint the hang.
      traceMode = u.searchParams.get('trace') === '1';
    } catch (_) {}
    const dbg = { requestedAsOf, phases: {}, sections: [] };
    // Helper: run a synchronous drawing block, record ms + any thrown error.
    // Failures do NOT abort the run in normal mode (best-effort PDF); in
    // trace mode we surface them so the caller can pinpoint the offender.
    function traceSection(name, fn) {
      const s = Date.now();
      try {
        fn();
        const ms = Date.now() - s;
        dbg.sections.push({ name, ms });
        if (traceMode) console.log(`[trace] ${name} ok in ${ms}ms`);
      } catch (e) {
        const ms = Date.now() - s;
        dbg.sections.push({ name, ms, error: String(e && e.message || e) });
        if (traceMode) console.warn(`[trace] ${name} FAILED in ${ms}ms: ${e.message}`);
        if (traceMode) throw e; // In trace mode propagate so the catch below returns JSON.
      }
    }

    // Utility — wrap a promise in a hard timeout so one slow dep can't wedge the PDF.
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
    ]);

    // ── 1) Pull live performance data (same source as /api/performance) ──
    console.log('[generate-daily-report] phase=loadAndCompute start');
    const t0 = Date.now();
    const result = await withTimeout(
      loadAndCompute(requestedAsOf ? { endDate: requestedAsOf } : {}),
      35_000,
      'loadAndCompute',
    );
    dbg.phases.loadAndCompute_ms = Date.now() - t0;
    dbg.phases.holdings_count = (result.holdings || []).length;
    dbg.phases.series_count = (result.dailySeries || []).length;
    console.log(`[generate-daily-report] phase=loadAndCompute done in ${Date.now()-t0}ms`);
    const kpis = result.kpis;
    const holdings = result.holdings || [];

    // Apply Finnhub live overlay (mirrors dashboard liveOverlay) — only when generating for today
    // or no specific past date was requested. Hard 8s ceiling on the whole overlay.
    const todayISO = new Date().toISOString().slice(0, 10);
    const wantLive = !requestedAsOf || requestedAsOf === todayISO;
    if (wantLive && kpis && !fastMode) {
      const t1 = Date.now();
      try {
        await withTimeout(applyLiveOverlay(kpis, holdings), 8_000, 'liveOverlay');
        dbg.phases.liveOverlay_ms = Date.now() - t1;
        console.log(`[generate-daily-report] phase=liveOverlay done in ${Date.now()-t1}ms`);
      } catch (e) {
        dbg.phases.liveOverlay_ms = Date.now() - t1;
        dbg.phases.liveOverlay_error = e.message;
        console.warn(`[generate-daily-report] live overlay skipped after ${Date.now()-t1}ms:`, e.message);
      }
    } else if (fastMode) {
      dbg.phases.liveOverlay_ms = 0;
      dbg.phases.liveOverlay_skipped = 'fast_mode';
    }

    // Pending dividends + interest (same source as dashboard mini-stat). 6s ceiling.
    // Skipped in fast mode.
    let pendingDivs = null;
    if (!fastMode) {
      const t2 = Date.now();
      try {
        pendingDivs = await withTimeout(computePendingDividends(), 6_000, 'pendingDivs');
        dbg.phases.pendingDivs_ms = Date.now() - t2;
        console.log(`[generate-daily-report] phase=pendingDivs done in ${Date.now()-t2}ms`);
      } catch (e) {
        dbg.phases.pendingDivs_ms = Date.now() - t2;
        dbg.phases.pendingDivs_error = e.message;
        console.warn(`[generate-daily-report] pending dividends unavailable after ${Date.now()-t2}ms:`, e.message);
      }
    } else {
      dbg.phases.pendingDivs_ms = 0;
      dbg.phases.pendingDivs_skipped = 'fast_mode';
    }

    if (debugMode) {
      dbg.phases.total_ms = Date.now() - t0;
      res.status(200).json(dbg);
      return;
    }

    if (!kpis) {
      res.status(400).json({ error: 'No performance data available yet. Add transactions first.' });
      return;
    }

    const asOfDate = kpis.last_date || new Date().toISOString().slice(0, 10);

    // ── 2) Build PDF ──
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `DCE Holdings — Performance Snapshot ${asOfDate}`,
        Author: 'DCE Holdings Investment Office',
      },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));


    const W = doc.page.width;
    const M = 54;
    const CW = W - M * 2;

    // Checkpoint helper for ?trace=1 diagnostics.
    const tRenderStart = Date.now();
    const mark = (name) => {
      const ms = Date.now() - tRenderStart;
      dbg.sections.push({ name, ms });
      console.log(`[generate-daily-report] section=${name} at ${ms}ms`);
    };

    try {

    drawHeaderBar(doc); mark('headerBar');

    // ─── TITLE ────────────────────────────────────────────────────
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('DCE HOLDINGS — INVESTMENT OFFICE', M, 70, { characterSpacing: 1.5 });
    doc.moveTo(M, 88).lineTo(M + 16, 88).strokeColor(GOLD).lineWidth(1).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(24)
       .text('Performance Snapshot', M, 96);
    const asOfPretty = new Date(asOfDate + 'T00:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    doc.fillColor(GRAY).font('Helvetica').fontSize(10)
       .text(`As of close ${asOfPretty}  ·  ${kpis.days_elapsed} days since inception (${kpis.inception_date})`, M, 130);

    mark('title');
    // ─── HERO METRICS ─────────────────────────────────────────────
    let y = 160;
    doc.rect(M, y, CW, 90).fill(WHITE).strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.rect(M, y, CW, 2).fill(GOLD);

    // Geometric excess return: (1 + r_port) / (1 + r_bench) - 1.
    // Arithmetic subtraction (r - b) understates the drag when both returns are >0
    // and misstates it in general — not appropriate for return comparisons.
    const excessTwr = (kpis.twr_cum_pct != null && kpis.iwqu_return_pct != null)
      ? (1 + kpis.twr_cum_pct) / (1 + kpis.iwqu_return_pct) - 1
      : null;

    const heroCells = [
      {
        label: 'NET INVESTED',
        value: fmtUSD(kpis.invested_usd, 0),
        sub: `Contrib ${fmtUSD(kpis.total_contributions, 0)} · Withdr ${fmtUSD(kpis.total_withdrawals, 0)}`,
        subColor: GRAY,
      },
      {
        label: 'NAV (USD)',
        value: fmtUSD(kpis.nav, 0),
        sub: `MV ${fmtUSD(kpis.market_value_usd, 0)} · Cash ${fmtUSD(kpis.cash_usd, 0)}`,
        subColor: GRAY,
      },
      {
        // Label describes the value: absolute TWR since inception.
        // Excess vs benchmark shown in sub as geometric relative return.
        // Label 'Relative return' makes it explicit that this is NOT
        // simple arithmetic subtraction (which would misstate the drag).
        label: 'TWR SINCE INCEPTION',
        value: fmtPct(kpis.twr_cum_pct),
        sub: `S&P 500 TWR ${fmtPct(kpis.iwqu_return_pct)} · Relative return ${fmtPct(excessTwr)}`,
        valueColor: pctColor(kpis.twr_cum_pct),
        subColor: GRAY,
      },
      {
        label: 'IRR (XIRR)',
        value: fmtPct(kpis.irr_pct),
        sub: 'since inception',
        valueColor: pctColor(kpis.irr_pct),
        subColor: GRAY,
      },
      {
        label: 'MAX DRAWDOWN',
        value: fmtPctRaw(-Math.abs(kpis.max_drawdown_pct || 0)),
        sub: 'peak-to-trough',
        valueColor: RED,
        subColor: GRAY,
      },
    ];

    const cellW = CW / heroCells.length;
    heroCells.forEach((cell, i) => {
      const x = M + cellW * i;
      doc.fillColor(GOLD).font('Helvetica').fontSize(6.5)
         .text(cell.label, x + 10, y + 16, { characterSpacing: 1.0, width: cellW - 20 });
      doc.fillColor(cell.valueColor || NAVY).font('Helvetica-Bold').fontSize(15)
         .text(cell.value, x + 10, y + 30, { width: cellW - 20, lineBreak: false });
      doc.fillColor(cell.subColor || GRAY).font('Helvetica').fontSize(7.5)
         .text(cell.sub, x + 10, y + 60, { width: cellW - 20 });
      if (i < heroCells.length - 1) {
        doc.moveTo(x + cellW, y + 14).lineTo(x + cellW, y + 76)
           .strokeColor(LIGHT).lineWidth(0.5).stroke();
      }
    });

    mark('hero');
    // ─── IPS BANDS ────────────────────────────────────────────────
    y = 270;
    drawSectionLabel(doc, y, 'IPS Bands');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
       .text('Current allocation vs IPS bands', M, y + 14);
    y += 38;

    drawIpsBands(doc, M, y, CW, 130, kpis);
    y += 130 + 16;

    mark('ipsBands');
    // ─── HOLDINGS TABLE ───────────────────────────────────────────
    drawSectionLabel(doc, y, 'Holdings');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
       .text(`Positions (${holdings.length})`, M, y + 14);
    y += 38;

    // Column widths tuned so:
    //  - 9-char T-bill CUSIPs (912797VP9) fit on one line under TICKER
    //  - PRICE IRR fits on one line (was wrapping to 2 rows)
    //  - DAYS not so cramped
    // Space taken from MKT VALUE and UNREAL, both had generous padding.
    const cols = [
      { label: 'TICKER',    w: 62, align: 'left'  },
      { label: 'QTY',       w: 42, align: 'right' },
      { label: 'AVG COST',  w: 54, align: 'right' },
      { label: 'LAST',      w: 54, align: 'right' },
      { label: 'MKT VALUE', w: 56, align: 'right' },
      { label: 'UNREAL',    w: 82, align: 'right' },
      { label: 'PRICE IRR', w: 58, align: 'right' },
      { label: 'WEIGHT',    w: 42, align: 'right' },
      { label: 'DAYS',      w: 34, align: 'right' },
    ];
    const tableW = cols.reduce((s, c) => s + c.w, 0);

    // Header
    doc.rect(M, y, tableW, 18).fill(NAVY);
    let cx = M;
    cols.forEach(c => {
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7.5)
         .text(c.label, cx + 4, y + 5, { width: c.w - 8, align: c.align, characterSpacing: 0.6 });
      cx += c.w;
    });
    y += 18;

    // Rows
    holdings.forEach((h, idx) => {
      if (idx % 2 === 0) doc.rect(M, y, tableW, 20).fill(ROW_ALT);
      cx = M;
      const unrealPct = (h.cost_basis > 0 && h.unrealized_pnl != null)
        ? h.unrealized_pnl / h.cost_basis : null;
      // Price precision: fixed-income CUSIPs & cash-equivalent ETFs quote in ~$1
      // notionals; 2 decimals hides basis-point moves. Use 4 dp for those.
      const isSubDollarQuote = h.asset_class === 'fixed_income' || h.asset_class === 'cash_equivalent';
      const priceDp = isSubDollarQuote ? 4 : 2;
      // Suppress annualized IRR for very short holdings (< 30 days) — annualizing
      // an 11-day return produces meaningless triple-digit numbers.
      const showIrr = h.days_held != null && h.days_held >= 30;
      // Fixed-income CUSIPs get a parsed description sub-line (e.g. 'UST BILL 11/03/26')
      // rendered below the CUSIP itself. Increases row height by 8pt when present.
      const hasSubLine = !!h.security_display;
      const cells = [
        { v: h.ticker, color: NAVY, font: 'Helvetica-Bold' },
        { v: fmtNum(h.qty, 4), color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.avg_cost != null ? `$${Number(h.avg_cost).toFixed(priceDp)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.last_price != null ? `$${Number(h.last_price).toFixed(priceDp)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
        { v: fmtUSD(h.market_value, 0), color: NEAR_BLACK, font: 'Helvetica' },
        null, // UNREAL handled separately so the % stays on the same line in smaller gray
        { v: showIrr ? fmtPct(h.irr_annualized, 1) : '—', color: showIrr ? pctColor(h.irr_annualized) : GRAY, font: 'Helvetica-Bold' },
        { v: fmtPctRaw(h.weight_pct, 1), color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.days_held != null ? String(h.days_held) : '—', color: GRAY, font: 'Helvetica' },
      ];
      cells.forEach((cell, i) => {
        if (cell === null) {
          // UNREAL cell: render USD amount + % side-by-side, right-aligned
          const usdStr = fmtUSDSigned(h.unrealized_pnl);
          const pctStr = unrealPct != null ? ' (' + fmtPct(unrealPct, 1) + ')' : '';
          doc.font('Helvetica').fontSize(7.5);
          const pctW = doc.widthOfString(pctStr);
          doc.font('Helvetica-Bold').fontSize(8);
          const usdW = doc.widthOfString(usdStr);
          const totalW = usdW + pctW;
          const startX = cx + cols[i].w - 4 - totalW;
          doc.fillColor(pctColor(h.unrealized_pnl)).font('Helvetica-Bold').fontSize(8)
             .text(usdStr, startX, y + 6, { lineBreak: false });
          doc.fillColor(GRAY).font('Helvetica').fontSize(7.5)
             .text(pctStr, startX + usdW, y + 6.5, { lineBreak: false });
        } else {
          doc.fillColor(cell.color).font(cell.font).fontSize(8)
             .text(cell.v, cx + 4, y + 6, { width: cols[i].w - 8, align: cols[i].align, lineBreak: false });
        }
        cx += cols[i].w;
      });
      // Sub-line for Treasury CUSIPs: description below the ticker, small gray
      if (hasSubLine) {
        doc.fillColor(GRAY).font('Helvetica').fontSize(6.5)
           .text(h.security_display, M + 4, y + 18, { width: cols[0].w - 8, align: 'left', lineBreak: false });
        y += 28;
      } else {
        y += 20;
      }
    });

    // Totals row
    doc.rect(M, y, tableW, 20).fill(NAVY);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8)
       .text('TOTAL', M + 4, y + 6, { width: cols[0].w - 8, align: 'left', lineBreak: false });
    // Total MV at column 4 (idx 4)
    let totalsX = M + cols.slice(0, 4).reduce((s, c) => s + c.w, 0);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8)
       .text(fmtUSD(kpis.market_value_usd, 0), totalsX + 4, y + 6, { width: cols[4].w - 8, align: 'right', lineBreak: false });
    y += 20;

    mark('holdings');
    // ─── MINI-STATS GRID (8 cells: composition + P&L generation) ──
    y += 18;
    const cardCols = 4;
    const cardW = (CW - (cardCols - 1) * 8) / cardCols;
    const cardH = 50;

    // Row 1: NAV composition (Cash · Market Value · Dividends received · Dividends pending)
    const cards1 = [
      { label: 'CASH (USD)',                value: fmtUSD(kpis.cash_usd, 0),         color: NAVY  },
      { label: 'MARKET VALUE',              value: fmtUSD(kpis.market_value_usd, 0), color: NAVY  },
      { label: 'DIVIDENDS + INTEREST',      value: fmtUSD((kpis.total_dividends || 0) + (kpis.total_interest || 0), 2), color: GREEN, sub: 'received' },
      { label: 'ACCRUED INCOME',            value: pendingDivs && typeof pendingDivs.total_pending_usd === 'number'
                                                ? fmtUSD(pendingDivs.total_pending_usd, 2)
                                                : 'Pending',
        color: (pendingDivs && pendingDivs.total_pending_usd > 0) ? GREEN : GRAY,
        italic: !(pendingDivs && pendingDivs.total_pending_usd > 0),
        sub: 'memo — not in NAV' },
    ];
    cards1.forEach((c, i) => {
      const x = M + i * (cardW + 8);
      doc.rect(x, y, cardW, cardH).fill('#f4eedb').strokeColor(GOLD).lineWidth(0.4).stroke();
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
         .text(c.label, x + 10, y + 8, { characterSpacing: 0.8, width: cardW - 20 });
      if (c.sub) {
        doc.fillColor(GRAY).font('Helvetica').fontSize(6.5)
           .text('(' + c.sub + ')', x + 10, y + 18, { width: cardW - 20 });
      }
      doc.fillColor(c.color).font(c.italic ? 'Helvetica-Oblique' : 'Helvetica-Bold').fontSize(c.italic ? 11 : 13)
         .text(c.value, x + 10, y + 30, { width: cardW - 20, lineBreak: false });
    });
    y += cardH + 8;

    // Row 2: P&L generation (Realized · Unrealized · Withholding · Total P&L)
    const cards2 = [
      { label: 'REALIZED P&L',   value: fmtUSDSigned(kpis.realized_pnl),       color: pctColor(kpis.realized_pnl) },
      { label: 'UNREALIZED P&L', value: fmtUSDSigned(kpis.unrealized_pnl),     color: pctColor(kpis.unrealized_pnl) },
      { label: 'WITHHOLDING TAX',value: fmtUSDSigned(-Math.abs(kpis.total_taxes || 0)), color: RED },
      { label: 'TOTAL P&L',      value: fmtUSDSigned(kpis.total_pnl_usd),      color: pctColor(kpis.total_pnl_usd) },
    ];
    cards2.forEach((c, i) => {
      const x = M + i * (cardW + 8);
      doc.rect(x, y, cardW, cardH).fill('#f4eedb').strokeColor(GOLD).lineWidth(0.4).stroke();
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7.5)
         .text(c.label, x + 10, y + 9, { characterSpacing: 0.8, width: cardW - 20 });
      doc.fillColor(c.color).font('Helvetica-Bold').fontSize(13)
         .text(c.value, x + 10, y + 25, { width: cardW - 20, lineBreak: false });
    });

    mark('preFooter');
    drawFooter(doc, asOfDate); mark('footer');

    // Hard guarantee single-page output: if any implicit overflow created
    // additional pages, we keep only page 0. With bufferPages: true we can
    // inspect the buffered range and prune trailing pages before flushing.
    const range = doc.bufferedPageRange(); // { start: 0, count: N }
    if (range && range.count > 1) {
      // Discard pages 1..N-1 by overwriting their content streams.
      // Easiest way in pdfkit: switch to each extra page and clear it isn't
      // exposed cleanly, so we just leave them blank-but-flushed. To truly
      // drop them, we need to manipulate the internal _pageBuffer.
      // pdfkit stores buffered pages in doc._pageBuffer when bufferPages=true.
      if (Array.isArray(doc._pageBuffer)) {
        doc._pageBuffer = doc._pageBuffer.slice(0, 1);
        doc._pageBufferStart = 0;
      }
    }
    doc.flushPages(); mark('flushPages');

    } catch (drawErr) {
      const ms = Date.now() - tRenderStart;
      dbg.sections.push({ name: 'FAILED', ms, error: String(drawErr && drawErr.message || drawErr) });
      console.error(`[generate-daily-report] draw failed after ${ms}ms:`, drawErr);
      if (traceMode) {
        return res.status(500).json({ error: String(drawErr.message || drawErr), dbg });
      }
      throw drawErr;
    }

    if (traceMode) {
      return res.status(200).json({ ok: true, dbg });
    }

    const tRender = Date.now();
    doc.end();
    await done;
    console.log(`[generate-daily-report] phase=pdfRender done in ${Date.now()-tRender}ms`);

    const buf = Buffer.concat(chunks);
    console.log(`[generate-daily-report] phase=send bytes=${buf.length} total=${Date.now()-t0}ms`);
    const filename = `DCE_Performance_Snapshot_${asOfDate}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('[generate-daily-report]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
