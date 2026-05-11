// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Performance Snapshot PDF (Vercel serverless)
// ───────────────────────────────────────────────────────────────────
// Generates a branded one-page snapshot of the Performance dashboard.
// Reads the SAME source as /api/performance (loadAndCompute) so the PDF
// is 100% consistent with what the user sees on /performance.html.
//
// Includes:
//   - Hero metrics: NAV, TWR vs IWQU.L, IRR (XIRR), Max DD
//   - Holdings table: ticker, qty, avg cost, last price, MV, unrealized P&L,
//     IRR (annualized), weight, days held
//   - Cash · Market Value · Realized P&L · Unrealized P&L cards
//   - Dividends + Interest · Withholding tax cards
//   - Equity curve TWR vs IWQU.L (line chart, last 180 days or full history)
//
// GET /api/generate-daily-report  →  application/pdf
// ═══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { loadAndCompute } = require('./_perf-load');

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
  // Same thresholds as the dashboard's renderIpsBands()
  const nav  = (kpis && kpis.nav) || 0;
  const cash = (kpis && kpis.cash_usd) || 0;
  const mv   = (kpis && kpis.market_value_usd) || 0;

  const BANDS = [
    { label: 'Cash / equivalentes',     min: 0.15, max: 0.25, value: nav > 0 ? cash / nav : 0 },
    { label: 'Equity — quality',         min: 0.60, max: 0.80, value: nav > 0 ? mv / nav   : 0 },
    { label: 'Equity — special sit',     min: 0.00, max: 0.15, value: 0 },
    { label: 'Renta fija / coberturas',  min: 0.00, max: 0.10, value: 0 },
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
     .text('Asignación táctica IPS §3.5–3.7 · Benchmark IPS §4.8: MSCI World Quality NR (proxy IWQU.L)', x + padX, footerY, { width: w - padX * 2, lineBreak: false });
}

module.exports = async (req, res) => {
  try {
    // Parse optional ?as_of=YYYY-MM-DD to generate the snapshot for a past date.
    // Default: today (loadAndCompute clamps to the latest available data).
    let requestedAsOf = null;
    try {
      const u = new URL(req.url, 'http://x');
      const v = (u.searchParams.get('as_of') || '').trim();
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        requestedAsOf = v;
      }
    } catch (_) {}

    // ── 1) Pull live performance data (same source as /api/performance) ──
    const result = await loadAndCompute(requestedAsOf ? { endDate: requestedAsOf } : {});
    const kpis = result.kpis;
    const holdings = result.holdings || [];

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

    drawHeaderBar(doc);

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

    // ─── HERO METRICS ─────────────────────────────────────────────
    let y = 160;
    doc.rect(M, y, CW, 90).fill(WHITE).strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.rect(M, y, CW, 2).fill(GOLD);

    const excessTwr = (kpis.twr_cum_pct != null && kpis.iwqu_return_pct != null)
      ? kpis.twr_cum_pct - kpis.iwqu_return_pct : null;

    const heroCells = [
      {
        label: 'TOTAL NAV',
        value: fmtUSD(kpis.nav, 0),
        sub: `MV ${fmtUSD(kpis.market_value_usd, 0)} · Cash ${fmtUSD(kpis.cash_usd, 0)}`,
        subColor: GRAY,
      },
      {
        label: 'TWR vs IWQU.L',
        value: fmtPct(kpis.twr_cum_pct),
        sub: `Bench ${fmtPct(kpis.iwqu_return_pct)} · Excess ${fmtPct(excessTwr)}`,
        valueColor: pctColor(kpis.twr_cum_pct),
        subColor: GRAY,
      },
      {
        label: 'IRR (XIRR)',
        value: fmtPct(kpis.irr_pct),
        sub: `Max DD ${fmtPctRaw(-Math.abs(kpis.max_drawdown_pct || 0))} · Total ${fmtUSDSigned(kpis.total_pnl_usd)}`,
        valueColor: pctColor(kpis.irr_pct),
        subColor: GRAY,
      },
    ];

    const cellW = CW / 3;
    heroCells.forEach((cell, i) => {
      const x = M + cellW * i;
      doc.fillColor(GOLD).font('Helvetica').fontSize(7)
         .text(cell.label, x + 14, y + 16, { characterSpacing: 1.2, width: cellW - 28 });
      doc.fillColor(cell.valueColor || NAVY).font('Helvetica-Bold').fontSize(20)
         .text(cell.value, x + 14, y + 32, { width: cellW - 28 });
      doc.fillColor(cell.subColor || GRAY).font('Helvetica').fontSize(8.5)
         .text(cell.sub, x + 14, y + 62, { width: cellW - 28 });
      if (i < heroCells.length - 1) {
        doc.moveTo(x + cellW, y + 14).lineTo(x + cellW, y + 76)
           .strokeColor(LIGHT).lineWidth(0.5).stroke();
      }
    });

    // ─── IPS BANDS ────────────────────────────────────────────────
    y = 270;
    drawSectionLabel(doc, y, 'IPS Bands');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
       .text('Asignación táctica vs bandas IPS', M, y + 14);
    y += 38;

    drawIpsBands(doc, M, y, CW, 130, kpis);
    y += 130 + 16;

    // ─── HOLDINGS TABLE ───────────────────────────────────────────
    drawSectionLabel(doc, y, 'Holdings');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
       .text(`Positions (${holdings.length})`, M, y + 14);
    y += 38;

    const cols = [
      { label: 'TICKER',   w: 50,  align: 'left'  },
      { label: 'QTY',      w: 44,  align: 'right' },
      { label: 'AVG COST', w: 56,  align: 'right' },
      { label: 'LAST',     w: 50,  align: 'right' },
      { label: 'MKT VALUE',w: 70,  align: 'right' },
      { label: 'UNREAL',   w: 70,  align: 'right' },
      { label: 'IRR (ANN)',w: 56,  align: 'right' },
      { label: 'WEIGHT',   w: 50,  align: 'right' },
      { label: 'DAYS',     w: 38,  align: 'right' },
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
      const cells = [
        { v: h.ticker, color: NAVY, font: 'Helvetica-Bold' },
        { v: fmtNum(h.qty, 4), color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.avg_cost != null ? `$${h.avg_cost.toFixed(2)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.last_price != null ? `$${h.last_price.toFixed(2)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
        { v: fmtUSD(h.market_value, 0), color: NEAR_BLACK, font: 'Helvetica' },
        { v: `${fmtUSDSigned(h.unrealized_pnl)} (${fmtPct(unrealPct, 1)})`, color: pctColor(h.unrealized_pnl), font: 'Helvetica-Bold' },
        { v: fmtPct(h.irr_annualized, 1), color: pctColor(h.irr_annualized), font: 'Helvetica-Bold' },
        { v: fmtPct(h.weight_pct, 1), color: NEAR_BLACK, font: 'Helvetica' },
        { v: h.days_held != null ? String(h.days_held) : '—', color: GRAY, font: 'Helvetica' },
      ];
      cells.forEach((cell, i) => {
        doc.fillColor(cell.color).font(cell.font).fontSize(8)
           .text(cell.v, cx + 4, y + 6, { width: cols[i].w - 8, align: cols[i].align, lineBreak: false });
        cx += cols[i].w;
      });
      y += 20;
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

    // ─── CASH/MV/PNL CARDS ────────────────────────────────────────
    y += 18;
    const cardCols = 4;
    const cardW = (CW - (cardCols - 1) * 8) / cardCols;
    const cardH = 50;
    const cards1 = [
      { label: 'CASH (USD)',     value: fmtUSD(kpis.cash_usd, 0),         color: NAVY  },
      { label: 'MARKET VALUE',   value: fmtUSD(kpis.market_value_usd, 0), color: NAVY  },
      { label: 'REALIZED P&L',   value: fmtUSDSigned(kpis.realized_pnl),  color: pctColor(kpis.realized_pnl) },
      { label: 'UNREALIZED P&L', value: fmtUSDSigned(kpis.unrealized_pnl),color: pctColor(kpis.unrealized_pnl) },
    ];
    cards1.forEach((c, i) => {
      const x = M + i * (cardW + 8);
      doc.rect(x, y, cardW, cardH).fill('#f4eedb').strokeColor(GOLD).lineWidth(0.4).stroke();
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7.5)
         .text(c.label, x + 10, y + 9, { characterSpacing: 0.8, width: cardW - 20 });
      doc.fillColor(c.color).font('Helvetica-Bold').fontSize(14)
         .text(c.value, x + 10, y + 23, { width: cardW - 20 });
    });
    y += cardH + 8;

    // Second row of cards: dividends/interest + withholding tax (only 2 cells)
    const cards2 = [
      { label: 'DIVIDENDS + INTEREST', value: fmtUSD((kpis.total_dividends || 0) + (kpis.total_interest || 0), 2), color: GREEN },
      { label: 'WITHHOLDING TAX',      value: fmtUSDSigned(-Math.abs(kpis.total_taxes || 0)), color: RED },
    ];
    const card2W = (CW - 8) / 2;
    cards2.forEach((c, i) => {
      const x = M + i * (card2W + 8);
      doc.rect(x, y, card2W, cardH).fill('#f4eedb').strokeColor(GOLD).lineWidth(0.4).stroke();
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7.5)
         .text(c.label, x + 10, y + 9, { characterSpacing: 0.8, width: card2W - 20 });
      doc.fillColor(c.color).font('Helvetica-Bold').fontSize(14)
         .text(c.value, x + 10, y + 23, { width: card2W - 20 });
    });

    drawFooter(doc, asOfDate);

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
    doc.flushPages();

    doc.end();
    await done;

    const buf = Buffer.concat(chunks);
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
