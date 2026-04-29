// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Daily Report Generator (Vercel serverless)
// ───────────────────────────────────────────────────────────────────
// Reads /data/portfolio.json, fetches current prices from Finnhub
// (positions + ^GSPC benchmark), computes YTD vs S&P 500 + Inception
// CAGR, and returns a branded PDF (DCE_NAVY/GOLD).
//
// GET /api/generate-daily-report
//   → application/pdf attachment
// ═══════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const FH_KEY = 'd6pi2h1r01qo88ajadq0d6pi2h1r01qo88ajadqg';

// Brand colors
const NAVY = '#1b2642';
const GOLD = '#b88b47';
const GRAY = '#606060';
const LIGHT = '#e6e6e6';
const GREEN = '#2a7a56';
const RED   = '#9b2335';
const NEAR_BLACK = '#0d0d0d';

async function fetchQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${symbol} -> ${r.status}`);
  return r.json(); // { c, d, dp, h, l, o, pc, t }
}

async function fetchSP500Historical(unixTs) {
  // Finnhub /stock/candle is premium; use a public free endpoint via Yahoo Finance v8
  // Returns close price on the requested day (or nearest trading day after).
  const from = unixTs;
  const to = unixTs + 7 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${from}&period2=${to}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!closes) return null;
  for (const c of closes) if (c) return c;
  return null;
}

function fmtUSD(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
}
function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}
function pctColor(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return NEAR_BLACK;
  return n >= 0 ? GREEN : RED;
}
function yearsBetween(d1, d2) {
  const ms = d2.getTime() - d1.getTime();
  return ms / (365.25 * 24 * 3600 * 1000);
}

export default async function handler(req, res) {
  try {
    // 1) Load portfolio
    const portfolioPath = path.join(process.cwd(), 'data', 'portfolio.json');
    const portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf-8'));

    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const cash = Number(portfolio.cash || 0);
    const inceptionDate = new Date(portfolio.inception_date);
    const inceptionValue = Number(portfolio.inception_value);
    const bmInceptionValue = Number(portfolio.benchmark_inception_value);

    // 2) Fetch current prices for every position + S&P 500
    const tickers = positions.map(p => p.ticker);
    const allSymbols = [...tickers, '^GSPC'];
    const quotes = {};
    await Promise.all(
      allSymbols.map(async sym => {
        try {
          // Finnhub uses ^GSPC -> needs different proxy; fall back to Yahoo for ^GSPC.
          if (sym === '^GSPC') {
            const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const j = await r.json();
            const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
            const lastTwo = closes.filter(Boolean).slice(-2);
            const c = lastTwo[lastTwo.length - 1];
            const pc = lastTwo.length === 2 ? lastTwo[0] : null;
            quotes[sym] = { c, pc, dp: pc ? ((c - pc) / pc) * 100 : null };
          } else {
            quotes[sym] = await fetchQuote(sym);
          }
        } catch (e) {
          quotes[sym] = { error: String(e.message || e) };
        }
      })
    );

    // 3) Compute YTD start prices (Jan 1 of current year)
    const now = new Date();
    const year = now.getUTCFullYear();
    const ytdStart = new Date(Date.UTC(year, 0, 2)); // Jan 2 to land on first trading day
    const ytdStartTs = Math.floor(ytdStart.getTime() / 1000);

    const ytdStartPrices = {};
    await Promise.all(
      allSymbols.map(async sym => {
        try {
          const yahooSym = sym === '^GSPC' ? '%5EGSPC' : sym;
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?period1=${ytdStartTs}&period2=${ytdStartTs + 7 * 86400}&interval=1d`;
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const j = await r.json();
          const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
          for (const c of closes) if (c) { ytdStartPrices[sym] = c; break; }
        } catch {}
      })
    );

    // 4) Compute portfolio metrics
    const enrichedPositions = positions.map(p => {
      const q = quotes[p.ticker] || {};
      const price = q.c;
      const prevClose = q.pc;
      const market_value = price ? price * p.shares : null;
      const day_change = prevClose && price ? (price - prevClose) * p.shares : null;
      const day_change_pct = q.dp ?? null;
      const cost_basis = Number(p.cost_basis_total || 0);
      const unrealized = market_value !== null ? market_value - cost_basis : null;
      const unrealized_pct = market_value !== null && cost_basis ? (unrealized / cost_basis) * 100 : null;
      return { ...p, price, prevClose, market_value, day_change, day_change_pct, cost_basis, unrealized, unrealized_pct };
    });

    const equity_value = enrichedPositions.reduce((s, p) => s + (p.market_value || 0), 0);
    const total_value = equity_value + cash;
    const day_change_total = enrichedPositions.reduce((s, p) => s + (p.day_change || 0), 0);
    const day_change_total_pct = (total_value - day_change_total) > 0
      ? (day_change_total / (total_value - day_change_total)) * 100
      : null;

    // 5) YTD performance — fund vs benchmark
    const ytdValueOfFund = enrichedPositions.reduce((sum, p) => {
      const ytdPx = ytdStartPrices[p.ticker];
      return sum + (ytdPx ? ytdPx * p.shares : 0);
    }, 0) + cash;
    const ytd_fund_pct = ytdValueOfFund ? ((total_value - ytdValueOfFund) / ytdValueOfFund) * 100 : null;

    const sp500_now = quotes['^GSPC']?.c;
    const sp500_ytd_start = ytdStartPrices['^GSPC'];
    const ytd_sp500_pct = sp500_now && sp500_ytd_start ? ((sp500_now - sp500_ytd_start) / sp500_ytd_start) * 100 : null;

    // 6) Inception CAGR — fund vs benchmark
    const years = Math.max(yearsBetween(inceptionDate, now), 0.01);
    const fund_total_return = (total_value / inceptionValue) - 1;
    const fund_cagr = (Math.pow(1 + fund_total_return, 1 / years) - 1) * 100;

    const sp500_total_return = sp500_now && bmInceptionValue ? (sp500_now / bmInceptionValue) - 1 : null;
    const sp500_cagr = sp500_total_return !== null ? (Math.pow(1 + sp500_total_return, 1 / years) - 1) * 100 : null;

    // 7) Build PDF
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
      info: {
        Title: `DCE Holdings — Daily Report ${now.toISOString().slice(0, 10)}`,
        Author: 'DCE Holdings Investment Office',
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));

    // ─── HEADER BAR ───────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 40).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
       .text('DCE HOLDINGS  ·  INVESTMENT OFFICE', 54, 14, { lineBreak: false });
    doc.fillColor(GOLD).font('Helvetica').fontSize(9)
       .text('Daily Report', 54, 14, { width: doc.page.width - 108, align: 'right' });

    // ─── TITLE ────────────────────────────────────────────────────
    doc.moveDown(2);
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('DCE HOLDINGS — INVESTMENT OFFICE', 54, 70, { characterSpacing: 1.5 });
    doc.moveTo(54, 88).lineTo(70, 88).strokeColor(GOLD).lineWidth(1).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(24)
       .text('Daily Report', 54, 96);
    doc.fillColor(GRAY).font('Helvetica').fontSize(10)
       .text(`As of close ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`, 54, 130);

    // ─── HERO METRICS ─────────────────────────────────────────────
    let y = 160;
    doc.rect(54, y, doc.page.width - 108, 90).fill('#ffffff').strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.rect(54, y, doc.page.width - 108, 2).fill(GOLD);

    const cellW = (doc.page.width - 108) / 3;
    const heroCells = [
      { label: 'TOTAL NAV', value: fmtUSD(total_value), sub: `Day ${fmtPct(day_change_total_pct)} · ${fmtUSD(day_change_total)}`, subColor: pctColor(day_change_total_pct) },
      { label: 'YTD vs S&P 500', value: fmtPct(ytd_fund_pct), sub: `S&P 500: ${fmtPct(ytd_sp500_pct)} · vs ${fmtPct((ytd_fund_pct ?? 0) - (ytd_sp500_pct ?? 0))}`, valueColor: pctColor(ytd_fund_pct), subColor: GRAY },
      { label: 'INCEPTION CAGR', value: fmtPct(fund_cagr), sub: `S&P 500: ${fmtPct(sp500_cagr)} · ${years.toFixed(2)} yrs`, valueColor: pctColor(fund_cagr), subColor: GRAY },
    ];
    heroCells.forEach((cell, i) => {
      const x = 54 + cellW * i;
      doc.fillColor(GOLD).font('Helvetica').fontSize(7)
         .text(cell.label, x + 14, y + 16, { characterSpacing: 1.2, width: cellW - 28 });
      doc.fillColor(cell.valueColor || NAVY).font('Helvetica-Bold').fontSize(20)
         .text(cell.value, x + 14, y + 32, { width: cellW - 28 });
      doc.fillColor(cell.subColor || GRAY).font('Helvetica').fontSize(9)
         .text(cell.sub, x + 14, y + 62, { width: cellW - 28 });
      if (i < heroCells.length - 1) {
        doc.moveTo(x + cellW, y + 14).lineTo(x + cellW, y + 76).strokeColor(LIGHT).lineWidth(0.5).stroke();
      }
    });

    // ─── HOLDINGS TABLE ───────────────────────────────────────────
    y = 270;
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('— HOLDINGS', 54, y, { characterSpacing: 1.4 });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
       .text('Positions', 54, y + 14);

    y += 46;
    const cols = [
      { label: 'TICKER',     w: 56,  align: 'left' },
      { label: 'NAME',       w: 120, align: 'left' },
      { label: 'SHARES',     w: 48,  align: 'right' },
      { label: 'PRICE',      w: 58,  align: 'right' },
      { label: 'MKT VALUE',  w: 76,  align: 'right' },
      { label: 'DAY %',      w: 56,  align: 'right' },
      { label: 'UNREAL %',   w: 60,  align: 'right' },
    ];
    const tableX = 54;

    // Header
    doc.rect(tableX, y, cols.reduce((s, c) => s + c.w, 0), 18).fill(NAVY);
    let cx = tableX;
    cols.forEach(c => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
         .text(c.label, cx + 4, y + 5, { width: c.w - 8, align: c.align, characterSpacing: 0.6 });
      cx += c.w;
    });
    y += 18;

    // Rows
    enrichedPositions.forEach((p, idx) => {
      if (idx % 2 === 0) {
        doc.rect(tableX, y, cols.reduce((s, c) => s + c.w, 0), 22).fill('#fafaf7');
      }
      cx = tableX;
      const cells = [
        { v: p.ticker, color: NAVY, font: 'Helvetica-Bold' },
        { v: p.name || '', color: NEAR_BLACK, font: 'Helvetica' },
        { v: String(p.shares), color: NEAR_BLACK, font: 'Helvetica' },
        { v: p.price ? `$${p.price.toFixed(2)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
        { v: fmtUSD(p.market_value), color: NEAR_BLACK, font: 'Helvetica' },
        { v: fmtPct(p.day_change_pct), color: pctColor(p.day_change_pct), font: 'Helvetica-Bold' },
        { v: fmtPct(p.unrealized_pct), color: pctColor(p.unrealized_pct), font: 'Helvetica-Bold' },
      ];
      cells.forEach((cell, i) => {
        doc.fillColor(cell.color).font(cell.font).fontSize(9)
           .text(cell.v, cx + 4, y + 6, { width: cols[i].w - 8, align: cols[i].align, lineBreak: false });
        cx += cols[i].w;
      });
      y += 22;
    });

    // Cash row
    if (cash > 0) {
      doc.rect(tableX, y, cols.reduce((s, c) => s + c.w, 0), 22).fill('#fafaf7');
      doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9)
         .text('CASH', tableX + 4, y + 6, { lineBreak: false });
      const totW = cols.reduce((s, c) => s + c.w, 0);
      doc.text(fmtUSD(cash), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + 4, y + 6, { width: cols[4].w - 8, align: 'right', lineBreak: false });
      y += 22;
    }

    // Totals
    doc.rect(tableX, y, cols.reduce((s, c) => s + c.w, 0), 22).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
       .text('TOTAL NAV', tableX + 4, y + 6, { lineBreak: false });
    doc.text(fmtUSD(total_value), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + 4, y + 6, { width: cols[4].w - 8, align: 'right', lineBreak: false });
    doc.fillColor(day_change_total_pct >= 0 ? '#9be4c0' : '#ffb3bb').font('Helvetica-Bold').fontSize(9)
       .text(fmtPct(day_change_total_pct), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + cols[4].w + 4, y + 6, { width: cols[5].w - 8, align: 'right', lineBreak: false });
    y += 22;

    // ─── INCEPTION SECTION ───────────────────────────────────────
    y += 24;
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('— PERFORMANCE', 54, y, { characterSpacing: 1.4 });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
       .text('Performance vs S&P 500', 54, y + 14);

    y += 48;

    // Two-column performance summary
    const perfTable = [
      ['', 'DCE Holdings', 'S&P 500', 'Excess'],
      ['Day', fmtPct(day_change_total_pct), fmtPct(quotes['^GSPC']?.dp), fmtPct((day_change_total_pct ?? 0) - (quotes['^GSPC']?.dp ?? 0))],
      ['YTD', fmtPct(ytd_fund_pct), fmtPct(ytd_sp500_pct), fmtPct((ytd_fund_pct ?? 0) - (ytd_sp500_pct ?? 0))],
      ['Total return (since inception)', fmtPct(fund_total_return * 100), fmtPct(sp500_total_return !== null ? sp500_total_return * 100 : null), fmtPct((fund_total_return * 100) - (sp500_total_return !== null ? sp500_total_return * 100 : 0))],
      ['CAGR (since inception)', fmtPct(fund_cagr), fmtPct(sp500_cagr), fmtPct((fund_cagr ?? 0) - (sp500_cagr ?? 0))],
    ];
    const perfColW = [180, 110, 110, 100];
    perfTable.forEach((row, i) => {
      const rowH = 22;
      if (i === 0) {
        doc.rect(tableX, y, perfColW.reduce((s, w) => s + w, 0), rowH).fill(NAVY);
      } else if (i % 2 === 0) {
        doc.rect(tableX, y, perfColW.reduce((s, w) => s + w, 0), rowH).fill('#fafaf7');
      }
      let rcx = tableX;
      row.forEach((cell, j) => {
        const isHeader = i === 0;
        const isExcess = j === 3 && !isHeader;
        let color = isHeader ? '#ffffff' : (j === 0 ? NAVY : NEAR_BLACK);
        if (isExcess) {
          // parse the value to color it
          const num = parseFloat(String(cell).replace(/[+%]/g, ''));
          color = !Number.isNaN(num) ? (num >= 0 ? GREEN : RED) : NEAR_BLACK;
        }
        doc.fillColor(color)
           .font(isHeader || j === 0 ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(9)
           .text(cell, rcx + 6, y + 7, { width: perfColW[j] - 12, align: j === 0 ? 'left' : 'right', lineBreak: false });
        rcx += perfColW[j];
      });
      y += rowH;
    });

    // ─── FOOTER ──────────────────────────────────────────────────
    const footerY = doc.page.height - 50;
    doc.moveTo(54, footerY).lineTo(doc.page.width - 54, footerY).strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.fillColor(GRAY).font('Helvetica').fontSize(7)
       .text(`Generated ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC  ·  Source: Finnhub (positions) + Yahoo Finance (S&P 500)`, 54, footerY + 8, { width: doc.page.width - 108, align: 'left', characterSpacing: 0.4 });
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
       .text('DCE Holdings Investment Office — Confidential · Internal use only', 54, footerY + 22, { width: doc.page.width - 108, align: 'left' });

    doc.end();
    await done;

    const buf = Buffer.concat(chunks);
    const filename = `DCE_Daily_Report_${now.toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('[generate-daily-report]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
