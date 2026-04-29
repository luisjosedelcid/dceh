// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Daily Report Generator (Vercel serverless)
// ───────────────────────────────────────────────────────────────────
// Reads /data/portfolio.json (the single source of truth for both
// /portfolio.html and this report). Fetches live prices from Finnhub,
// S&P 500 (^GSPC) live + at YTD start + at inception from Yahoo,
// computes day P&L, YTD vs S&P 500, Inception CAGR vs benchmark,
// and returns a branded PDF (DCE_NAVY/GOLD).
//
// GET /api/generate-daily-report → application/pdf attachment
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

async function fetchFinnhubQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${symbol} -> ${r.status}`);
  return r.json(); // { c (current), pc (prev close), dp (day pct) }
}

async function fetchYahooQuote(symbol, range = '5d') {
  // Returns last close + previous close from chart endpoint
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Boolean);
  if (closes.length === 0) return null;
  const c = closes[closes.length - 1];
  const pc = closes.length >= 2 ? closes[closes.length - 2] : null;
  return { c, pc, dp: pc ? ((c - pc) / pc) * 100 : null };
}

async function fetchYahooCloseAt(symbol, unixTs) {
  // First trading-day close on or after unixTs (within +14 days)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${unixTs}&period2=${unixTs + 14 * 86400}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
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
  return (d2.getTime() - d1.getTime()) / (365.25 * 24 * 3600 * 1000);
}

export default async function handler(req, res) {
  try {
    // 1) Load portfolio (single source of truth, served from public/data/)
    const portfolioPath = path.join(process.cwd(), 'public', 'data', 'portfolio.json');
    const portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf-8'));

    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    const cash = Number(portfolio.cash || 0);
    const benchmarkSym = portfolio.benchmark || '^GSPC';
    const benchmarkLabel = portfolio.benchmark_label || 'S&P 500';

    // Earliest buy_date OR explicit inception_date OR today
    const buyDates = positions
      .map(p => p.buy_date)
      .filter(Boolean)
      .map(d => new Date(d));
    const inceptionDate = portfolio.inception_date
      ? new Date(portfolio.inception_date)
      : (buyDates.length ? new Date(Math.min(...buyDates)) : new Date());

    // 2) Live quotes for all positions + benchmark
    const tickers = positions.map(p => p.ticker);
    const quotes = {};
    await Promise.all([
      ...tickers.map(async sym => {
        try { quotes[sym] = await fetchFinnhubQuote(sym); }
        catch (e) { quotes[sym] = { error: String(e.message || e) }; }
      }),
      (async () => {
        try { quotes[benchmarkSym] = await fetchYahooQuote(benchmarkSym, '5d') || {}; }
        catch (e) { quotes[benchmarkSym] = { error: String(e.message || e) }; }
      })(),
    ]);

    // 3) YTD start prices (Jan 2 of current year → first trading day)
    const now = new Date();
    const ytdStartTs = Math.floor(Date.UTC(now.getUTCFullYear(), 0, 2) / 1000);
    const ytdStartPrices = {};
    await Promise.all(
      [...tickers, benchmarkSym].map(async sym => {
        ytdStartPrices[sym] = await fetchYahooCloseAt(sym, ytdStartTs);
      })
    );

    // 4) Benchmark close at fund inception (auto-fetched)
    const bmInceptionValue = await fetchYahooCloseAt(
      benchmarkSym,
      Math.floor(inceptionDate.getTime() / 1000)
    );

    // 5) Compute per-position metrics
    const enriched = positions.map(p => {
      const q = quotes[p.ticker] || {};
      const price = q.c ?? null;
      const prevClose = q.pc ?? null;
      const avgCost = Number(p.avg_cost || 0);
      const shares = Number(p.shares || 0);
      const cost_basis = shares * avgCost;
      const market_value = price !== null ? shares * price : null;
      const day_change = (prevClose !== null && price !== null) ? (price - prevClose) * shares : null;
      const day_change_pct = q.dp ?? null;
      const unrealized = market_value !== null ? market_value - cost_basis : null;
      const unrealized_pct = market_value !== null && cost_basis ? (unrealized / cost_basis) * 100 : null;
      // YTD per position
      const ytdPx = ytdStartPrices[p.ticker];
      const ytd_pct = (ytdPx && price) ? ((price - ytdPx) / ytdPx) * 100 : null;
      return { ...p, price, prevClose, cost_basis, market_value, day_change, day_change_pct, unrealized, unrealized_pct, ytdStartPrice: ytdPx, ytd_pct };
    });

    // 6) Portfolio aggregates
    const equity_value = enriched.reduce((s, p) => s + (p.market_value || 0), 0);
    const total_value = equity_value + cash;
    const day_change_total = enriched.reduce((s, p) => s + (p.day_change || 0), 0);
    const prev_total_value = total_value - day_change_total;
    const day_change_total_pct = prev_total_value > 0 ? (day_change_total / prev_total_value) * 100 : null;

    const total_cost_basis = enriched.reduce((s, p) => s + p.cost_basis, 0) + cash;
    const total_unrealized = total_value - total_cost_basis;
    const total_unrealized_pct = total_cost_basis ? (total_unrealized / total_cost_basis) * 100 : null;

    // YTD: fund value at YTD start (using YTD start prices) vs today
    const ytdValueOfFund = enriched.reduce((sum, p) => {
      const ytdPx = ytdStartPrices[p.ticker];
      if (!ytdPx) return sum + (p.market_value || 0); // fallback
      return sum + (ytdPx * Number(p.shares || 0));
    }, 0) + cash;
    const ytd_fund_pct = ytdValueOfFund > 0 ? ((total_value - ytdValueOfFund) / ytdValueOfFund) * 100 : null;

    const sp500_now = quotes[benchmarkSym]?.c ?? null;
    const sp500_ytd_start = ytdStartPrices[benchmarkSym] ?? null;
    const ytd_sp500_pct = (sp500_now && sp500_ytd_start) ? ((sp500_now - sp500_ytd_start) / sp500_ytd_start) * 100 : null;

    // Inception: fund total return uses inception cost basis. CAGR only if >1 year (GIPS-style).
    const fund_total_return_pct = total_cost_basis > 0 ? ((total_value / total_cost_basis) - 1) * 100 : null;
    const years = yearsBetween(inceptionDate, now);
    const showCAGR = years >= 1.0;
    const fund_cagr = (showCAGR && total_cost_basis > 0)
      ? (Math.pow(total_value / total_cost_basis, 1 / years) - 1) * 100
      : null;

    const sp500_total_return_pct = (sp500_now && bmInceptionValue) ? ((sp500_now / bmInceptionValue) - 1) * 100 : null;
    const sp500_cagr = (sp500_total_return_pct !== null && showCAGR)
      ? (Math.pow(sp500_now / bmInceptionValue, 1 / years) - 1) * 100
      : null;

    // Hide YTD row if inception is within the current calendar year
    // (would be redundant with 'Total return since inception')
    const inceptionYear = inceptionDate.getUTCFullYear();
    const currentYear = now.getUTCFullYear();
    const showYTD = inceptionYear < currentYear;

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
      {
        label: 'TOTAL NAV',
        value: fmtUSD(total_value),
        sub: `Day ${fmtPct(day_change_total_pct)} · ${fmtUSD(day_change_total)}`,
        subColor: pctColor(day_change_total_pct),
      },
    ];
    if (showYTD) {
      heroCells.push({
        label: `YTD vs ${benchmarkLabel.toUpperCase()}`,
        value: fmtPct(ytd_fund_pct),
        sub: `${benchmarkLabel}: ${fmtPct(ytd_sp500_pct)} · vs ${fmtPct((ytd_fund_pct ?? 0) - (ytd_sp500_pct ?? 0))}`,
        valueColor: pctColor(ytd_fund_pct),
        subColor: GRAY,
      });
    }
    heroCells.push({
      label: showCAGR ? 'INCEPTION CAGR' : 'INCEPTION RETURN',
      value: showCAGR ? fmtPct(fund_cagr) : fmtPct(fund_total_return_pct),
      sub: `${benchmarkLabel}: ${fmtPct(showCAGR ? sp500_cagr : sp500_total_return_pct)} · ${years.toFixed(2)} yrs`,
      valueColor: pctColor(showCAGR ? fund_cagr : fund_total_return_pct),
      subColor: GRAY,
    });
    if (!showYTD) {
      // Add a 3rd cell on the right showing inception date itself for visual balance
      heroCells.push({
        label: 'INCEPTION',
        value: inceptionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
        sub: `Cost basis ${fmtUSD(total_cost_basis)} · ${Math.round(years * 365.25)} days held`,
        subColor: GRAY,
      });
    }
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
    const tableW = cols.reduce((s, c) => s + c.w, 0);

    // Header
    doc.rect(tableX, y, tableW, 18).fill(NAVY);
    let cx = tableX;
    cols.forEach(c => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
         .text(c.label, cx + 4, y + 5, { width: c.w - 8, align: c.align, characterSpacing: 0.6 });
      cx += c.w;
    });
    y += 18;

    // Rows
    enriched.forEach((p, idx) => {
      if (idx % 2 === 0) doc.rect(tableX, y, tableW, 22).fill('#fafaf7');
      cx = tableX;
      const cells = [
        { v: p.ticker, color: NAVY, font: 'Helvetica-Bold' },
        { v: p.name || '', color: NEAR_BLACK, font: 'Helvetica' },
        { v: String(p.shares), color: NEAR_BLACK, font: 'Helvetica' },
        { v: p.price !== null ? `$${p.price.toFixed(2)}` : '—', color: NEAR_BLACK, font: 'Helvetica' },
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
      doc.rect(tableX, y, tableW, 22).fill('#fafaf7');
      doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9)
         .text('CASH', tableX + 4, y + 6, { lineBreak: false });
      doc.text(fmtUSD(cash), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + 4, y + 6, { width: cols[4].w - 8, align: 'right', lineBreak: false });
      y += 22;
    }

    // Totals
    doc.rect(tableX, y, tableW, 22).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
       .text('TOTAL NAV', tableX + 4, y + 6, { lineBreak: false });
    doc.text(fmtUSD(total_value), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + 4, y + 6, { width: cols[4].w - 8, align: 'right', lineBreak: false });
    doc.fillColor(day_change_total_pct >= 0 ? '#9be4c0' : '#ffb3bb').font('Helvetica-Bold').fontSize(9)
       .text(fmtPct(day_change_total_pct), tableX + cols[0].w + cols[1].w + cols[2].w + cols[3].w + cols[4].w + 4, y + 6, { width: cols[5].w - 8, align: 'right', lineBreak: false });
    y += 22;

    // ─── PERFORMANCE vs BENCHMARK ─────────────────────────────────
    y += 24;
    doc.fillColor(GOLD).font('Helvetica').fontSize(8)
       .text('— PERFORMANCE', 54, y, { characterSpacing: 1.4 });
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
       .text(`Performance vs ${benchmarkLabel}`, 54, y + 14);

    y += 48;
    const perfTable = [
      ['', 'DCE Holdings', benchmarkLabel, 'Excess'],
      ['Day', fmtPct(day_change_total_pct), fmtPct(quotes[benchmarkSym]?.dp), fmtPct((day_change_total_pct ?? 0) - (quotes[benchmarkSym]?.dp ?? 0))],
    ];
    if (showYTD) {
      perfTable.push(['YTD', fmtPct(ytd_fund_pct), fmtPct(ytd_sp500_pct), fmtPct((ytd_fund_pct ?? 0) - (ytd_sp500_pct ?? 0))]);
    }
    perfTable.push(['Total return (since inception)', fmtPct(fund_total_return_pct), fmtPct(sp500_total_return_pct), fmtPct((fund_total_return_pct ?? 0) - (sp500_total_return_pct ?? 0))]);
    if (showCAGR) {
      perfTable.push(['CAGR (since inception)', fmtPct(fund_cagr), fmtPct(sp500_cagr), fmtPct((fund_cagr ?? 0) - (sp500_cagr ?? 0))]);
    }
    const perfColW = [180, 110, 110, 100];
    const perfTableW = perfColW.reduce((s, w) => s + w, 0);
    perfTable.forEach((row, i) => {
      const rowH = 22;
      if (i === 0) doc.rect(tableX, y, perfTableW, rowH).fill(NAVY);
      else if (i % 2 === 0) doc.rect(tableX, y, perfTableW, rowH).fill('#fafaf7');
      let rcx = tableX;
      row.forEach((cell, j) => {
        const isHeader = i === 0;
        const isExcess = j === 3 && !isHeader;
        let color = isHeader ? '#ffffff' : (j === 0 ? NAVY : NEAR_BLACK);
        if (isExcess) {
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

    // Inception meta line
    y += 12;
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(8)
       .text(
         `Inception ${inceptionDate.toISOString().slice(0, 10)}  ·  Cost basis ${fmtUSD(total_cost_basis)}  ·  ${benchmarkLabel} at inception ${bmInceptionValue ? bmInceptionValue.toFixed(2) : '—'}`,
         54, y, { width: doc.page.width - 108, characterSpacing: 0.3 }
       );

    // ─── FOOTER ──────────────────────────────────────────────────
    const footerY = doc.page.height - 50;
    doc.moveTo(54, footerY).lineTo(doc.page.width - 54, footerY).strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.fillColor(GRAY).font('Helvetica').fontSize(7)
       .text(`Generated ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC  ·  Source: Finnhub (positions) + Yahoo Finance (${benchmarkLabel})`, 54, footerY + 8, { width: doc.page.width - 108, characterSpacing: 0.4 });
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
       .text('DCE Holdings Investment Office — Confidential · Internal use only', 54, footerY + 22, { width: doc.page.width - 108 });

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
