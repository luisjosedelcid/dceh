// ═══════════════════════════════════════════════════════════════════
// Shared PDF helpers for DCE Holdings serverless reports.
// Extracted from api/generate-daily-report.js so both the Equity
// snapshot and the Consolidated snapshot render identically.
// ═══════════════════════════════════════════════════════════════════

// Brand colors (DCE brandbook — NAVY + GOLD)
const NAVY = '#1b2642';
const GOLD = '#b88b47';
const GRAY = '#606060';
const LIGHT = '#e6e6e6';
const GREEN = '#1f5f3f';
const RED   = '#7a1010';
const NEAR_BLACK = '#0d0d0d';
const WHITE = '#ffffff';
const CREAM = '#faf7f0';
const ROW_ALT = '#fafaf7';

// ─── Formatting helpers ────────────────────────────────────────────
function fmtUSD(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  // Use half-away-from-zero rounding (“banker’s cash”) instead of the default
  // banker’s rounding in Intl.NumberFormat. Prevents $449,376.50 from being
  // rendered as $449,376 (which shifts the totals by ±$1 for auditors).
  let rounded;
  if (digits === 0) {
    rounded = Math.sign(n) * Math.round(Math.abs(n));
  } else {
    const factor = Math.pow(10, digits);
    rounded = Math.sign(n) * Math.round(Math.abs(n) * factor) / factor;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    maximumFractionDigits: digits, minimumFractionDigits: digits,
  }).format(rounded);
}
function fmtUSDSigned(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${fmtUSD(Math.abs(n), 2)}`;
}
function fmtUSD0Signed(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${fmtUSD(Math.abs(n), 0)}`;
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
function fmtMoic(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(2) + 'x';
}
function fmtNum(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function fmtEUR(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'EUR',
    maximumFractionDigits: digits, minimumFractionDigits: digits,
  }).format(n);
}
function fmtQty(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
function fmtDate(s) { return s || '—'; }
function pctColor(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return NEAR_BLACK;
  return n >= 0 ? GREEN : RED;
}

// ─── PDF helpers ───────────────────────────────────────────────────
function drawHeaderBar(doc, subtitle = 'Performance Snapshot') {
  const W = doc.page.width;
  doc.rect(0, 0, W, 40).fill(NAVY);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11)
     .text('DCE HOLDINGS  ·  INVESTMENT OFFICE', 54, 14, { lineBreak: false });
  doc.fillColor(GOLD).font('Helvetica').fontSize(9)
     .text(subtitle, 54, 14, { width: W - 108, align: 'right' });
}

function drawFooter(doc, asOfDate, sourceLine = 'portfolio_snapshots + real estate + crypto + time-deposits') {
  const pageH = doc.page.height;
  const pageW = doc.page.width;
  const lineY = pageH - 42;
  const txt1Y = pageH - 32;
  const txt2Y = pageH - 18;

  doc.moveTo(54, lineY).lineTo(pageW - 54, lineY).strokeColor(GOLD).lineWidth(0.5).stroke();

  doc.fillColor(GRAY).font('Helvetica').fontSize(7)
     .text(
       `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  ·  As of ${asOfDate}  ·  Source: ${sourceLine}`,
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

// Draws a titled hero cell block at (x,y) with width w, height h.
// cell = { label, value, valueColor?, sub?, subColor? }
function drawHeroCell(doc, cell, x, y, w, h) {
  doc.fillColor(GOLD).font('Helvetica').fontSize(6.5)
     .text(cell.label, x + 10, y + 10, { width: w - 20, characterSpacing: 1.4 });
  doc.fillColor(cell.valueColor || NAVY).font('Helvetica-Bold').fontSize(15)
     .text(cell.value ?? '—', x + 10, y + 24, { width: w - 20, lineBreak: false, ellipsis: true });
  if (cell.sub) {
    doc.fillColor(cell.subColor || GRAY).font('Helvetica').fontSize(7)
       .text(cell.sub, x + 10, y + h - 20, { width: w - 20, lineBreak: false, ellipsis: true });
  }
}

module.exports = {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtUSDSigned, fmtUSD0Signed, fmtPct, fmtPctRaw, fmtMoic, fmtNum, fmtEUR, fmtQty, fmtDate, pctColor,
  drawHeaderBar, drawFooter, drawSectionLabel, drawHeroCell,
};
