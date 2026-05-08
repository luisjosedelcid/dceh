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
  const sign = n >= 0 ? '+' : '−';
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
  const footerY = doc.page.height - 50;
  doc.moveTo(54, footerY).lineTo(doc.page.width - 54, footerY).strokeColor(GOLD).lineWidth(0.5).stroke();
  doc.fillColor(GRAY).font('Helvetica').fontSize(7)
     .text(
       `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  ·  As of close ${asOfDate}  ·  Source: portfolio_snapshots + transactions + cashflows`,
       54, footerY + 8, { width: doc.page.width - 108, characterSpacing: 0.4 }
     );
  doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
     .text('DCE Holdings Investment Office — Confidential · Internal use only', 54, footerY + 22, { width: doc.page.width - 108 });
}

function drawSectionLabel(doc, y, label) {
  doc.fillColor(GOLD).font('Helvetica').fontSize(8)
     .text(`— ${label.toUpperCase()}`, 54, y, { characterSpacing: 1.4 });
}

// ─── Equity curve chart (TWR vs IWQU.L) ────────────────────────────
function drawEquityCurve(doc, x, y, w, h, series) {
  // series: [{ date, twr_cum, iwqu_norm }]
  // twr_cum is fraction (0.05 = +5%); iwqu_norm is multiplier (1.05 = +5%)
  // Normalize both to base 100 for visual equivalence
  const data = series
    .map(d => ({
      date: d.date,
      portfolio: d.twr_cum != null ? (1 + d.twr_cum) * 100 : null,
      bench: d.iwqu_norm != null ? d.iwqu_norm * 100 : null,
    }))
    .filter(d => d.portfolio != null);

  // Background
  doc.rect(x, y, w, h).fill(WHITE).strokeColor(LIGHT).lineWidth(0.5).stroke();

  if (data.length < 2) {
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9)
       .text('Insufficient data for equity curve.', x + 14, y + h / 2 - 6, { width: w - 28 });
    return;
  }

  // Plot area
  const padL = 36, padR = 12, padT = 14, padB = 26;
  const px = x + padL, py = y + padT;
  const pw = w - padL - padR, ph = h - padT - padB;

  const allVals = [];
  data.forEach(d => {
    allVals.push(d.portfolio);
    if (d.bench != null) allVals.push(d.bench);
  });
  let yMin = Math.min(...allVals);
  let yMax = Math.max(...allVals);
  // Pad y range 5%
  const range = (yMax - yMin) || 1;
  yMin -= range * 0.08;
  yMax += range * 0.08;

  const xAt = (i) => px + (i / (data.length - 1)) * pw;
  const yAt = (v) => py + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // Y gridlines + labels (5 lines)
  doc.lineWidth(0.3).strokeColor(LIGHT);
  for (let k = 0; k <= 4; k++) {
    const yg = py + (ph * k) / 4;
    doc.moveTo(px, yg).lineTo(px + pw, yg).stroke();
    const v = yMax - ((yMax - yMin) * k) / 4;
    doc.fillColor(GRAY).font('Helvetica').fontSize(7)
       .text(v.toFixed(0), x + 4, yg - 4, { width: padL - 6, align: 'right' });
  }

  // Baseline at 100
  if (100 >= yMin && 100 <= yMax) {
    const y100 = yAt(100);
    doc.lineWidth(0.5).strokeColor(GRAY).dash(2, { space: 2 })
       .moveTo(px, y100).lineTo(px + pw, y100).stroke().undash();
  }

  // X labels: first, mid, last date
  const xLabelIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  xLabelIdx.forEach(i => {
    doc.fillColor(GRAY).font('Helvetica').fontSize(7)
       .text(data[i].date, xAt(i) - 22, py + ph + 4, { width: 44, align: 'center' });
  });

  // Benchmark line (gold dashed)
  const benchPts = data.map((d, i) => ({ i, v: d.bench })).filter(p => p.v != null);
  if (benchPts.length >= 2) {
    doc.lineWidth(1).strokeColor(GOLD).dash(3, { space: 2 });
    benchPts.forEach((p, k) => {
      const xx = xAt(p.i), yy = yAt(p.v);
      if (k === 0) doc.moveTo(xx, yy);
      else doc.lineTo(xx, yy);
    });
    doc.stroke().undash();
  }

  // Portfolio line (navy solid)
  doc.lineWidth(1.4).strokeColor(NAVY);
  data.forEach((d, i) => {
    const xx = xAt(i), yy = yAt(d.portfolio);
    if (i === 0) doc.moveTo(xx, yy);
    else doc.lineTo(xx, yy);
  });
  doc.stroke();

  // Legend
  const legY = y + h - 12;
  doc.lineWidth(1.4).strokeColor(NAVY).moveTo(x + 14, legY).lineTo(x + 28, legY).stroke();
  doc.fillColor(NAVY).font('Helvetica').fontSize(8)
     .text('Portfolio TWR', x + 32, legY - 4, { lineBreak: false });
  doc.lineWidth(1).strokeColor(GOLD).dash(3, { space: 2 })
     .moveTo(x + 110, legY).lineTo(x + 124, legY).stroke().undash();
  doc.fillColor(GOLD).font('Helvetica').fontSize(8)
     .text('IWQU.L (MSCI World Quality)', x + 128, legY - 4, { lineBreak: false });
}

module.exports = async (req, res) => {
  try {
    // ── 1) Pull live performance data (same source as /api/performance) ──
    const result = await loadAndCompute({});
    const kpis = result.kpis;
    const holdings = result.holdings || [];
    const series = result.dailySeries || [];

    if (!kpis) {
      res.status(400).json({ error: 'No performance data available yet. Add transactions first.' });
      return;
    }

    const asOfDate = kpis.last_date || new Date().toISOString().slice(0, 10);

    // ── 2) Build PDF ──
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
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

    // ─── EQUITY CURVE ─────────────────────────────────────────────
    y = 270;
    drawSectionLabel(doc, y, 'Equity Curve');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
       .text('Portfolio TWR vs IWQU.L', M, y + 14);
    y += 38;

    // Use last 240 days max to keep chart readable; otherwise full series
    const chartSeries = series.length > 240 ? series.slice(-240) : series;
    drawEquityCurve(doc, M, y, CW, 130, chartSeries);
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
