// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Crypto Snapshot PDF
// Server-side replica of `tab-crypto` in /performance.html.
// Data source: /public/crypto_positions.json.
// NAV uses the static snapshot embedded in the JSON (mv_snapshot_usd)
// with cost-basis fallback — no live spot fetch to keep the endpoint
// well below the 504 window. The browser view still overlays live prices.
// One-page LETTER, DCE brand (NAVY + GOLD).
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtUSDSigned, fmtPct, fmtPctRaw, fmtMoic, fmtQty, pctColor,
  drawHeaderBar, drawFooter, drawSectionLabel, drawHeroCell,
} = require('./_pdf-helpers');

function readPublicJson(filename) {
  const candidates = [
    path.join(process.cwd(), 'public', filename),
    path.join(__dirname, '..', 'public', filename),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) { /* ignore */ }
  }
  return null;
}

function monthsBetween(d1YMD, d2YMD) {
  const a = new Date(d1YMD), b = new Date(d2YMD);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
function fmtHold(months) {
  if (months == null || months <= 0) return '—';
  const y = Math.floor(months / 12), m = Math.round(months % 12);
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} ${y === 1 ? 'yr' : 'yrs'}`;
  return `${y}y ${m}m`;
}

module.exports = async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
  if (!adminToken || adminToken !== process.env.DCE_ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const crJson = readPublicJson('crypto_positions.json');
    if (!crJson) {
      res.status(500).json({ error: 'crypto_positions.json not found' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const asOfStatic = crJson.as_of_static_data || '—';

    // Capital breakdown
    const capital = crJson.capital || {};
    const depositsFiat = Number(capital.deposits_fiat_acumulados_usd || 0);
    const withdrawalsFiat = Number(capital.withdrawals_fiat_to_bank_usd || 0);
    const capNeto = Number(capital.capital_neto_aportado_usd ??
      (depositsFiat + withdrawalsFiat));

    // Realized historical P&L (kept as informational; not part of NAV)
    const realizedHist = Number(crJson.realized_pnl_historico?.neto_usd || 0);

    // Enrich positions (cost-basis fallback for market value — no live spot)
    const positions = Array.isArray(crJson.positions) ? crJson.positions : [];
    const enriched = positions.map(p => {
      const qty = Number(p.quantity || 0);
      const costBasis = Number(p.cost_basis_total_usd || 0);
      // Prefer snapshot MV if the JSON carries one; else fall back to cost.
      const marketUsd = Number(
        p.mv_snapshot_usd
        ?? p.market_value_snapshot_usd
        ?? p.cost_basis_total_usd
        ?? 0
      );
      const priceLive = qty > 0 ? marketUsd / qty : Number(p.cost_basis_unit_usd || 0);
      const unrealUsd = marketUsd - costBasis;
      const unrealPct = costBasis > 0 ? unrealUsd / costBasis : null;
      return { ...p, qty, costBasis, marketUsd, priceLive, unrealUsd, unrealPct };
    });

    const totMarket = enriched.reduce((s, p) => s + p.marketUsd, 0);
    const totCost = enriched.reduce((s, p) => s + p.costBasis, 0);
    const totUnreal = totMarket - totCost;
    const pnlTotal = totUnreal + realizedHist;
    const roi = capNeto > 0 ? pnlTotal / capNeto : null;
    const moicSleeve = capNeto > 0 ? (totMarket + realizedHist) / capNeto : null;

    // Holding period since first deposit
    const firstDeposit = '2024-07-03';
    const holdMonths = monthsBetween(firstDeposit, today);

    // ─── Build PDF ───────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="DCE_Crypto_Snapshot_${today}.pdf"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    doc.pipe(res);

    const W = doc.page.width;
    drawHeaderBar(doc, 'Crypto Snapshot');

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
       .text('Crypto — Self-custody sleeve', 54, 62);
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(`Static NAV as of ${asOfStatic} · live prices overlaid in web view only`,
             54, 88);

    // ─── HERO STRIP (5 cells) ──────────────────────────────────
    const heroY = 110;
    const heroH = 62;
    const cellW = (W - 108) / 5;
    const cells = [
      { label: 'NET CAPITAL', value: fmtUSD(capNeto, 0),
        sub: `deposits ${fmtUSD(depositsFiat, 0)} − withdrawals ${fmtUSD(Math.abs(withdrawalsFiat), 0)}` },
      { label: 'NAV CRYPTO', value: fmtUSD(totMarket, 0),
        sub: (totUnreal >= 0 ? '+' : '') + fmtUSD(totUnreal, 0) +
             ' (' + (totCost > 0 ? fmtPctRaw(totUnreal / totCost, 2) : '—') + ' vs cost)',
        subColor: pctColor(totUnreal) },
      { label: 'CUMULATIVE P&L', value: (pnlTotal >= 0 ? '+' : '') + fmtUSD(pnlTotal, 0),
        valueColor: pctColor(pnlTotal),
        sub: `unrealized ${fmtUSDSigned(totUnreal)} + realized ${fmtUSD(realizedHist, 0)}` },
      { label: 'MOIC', value: fmtMoic(moicSleeve),
        valueColor: moicSleeve != null && moicSleeve >= 1 ? GREEN : RED,
        sub: 'over net capital' },
      { label: 'ROI OVER CAPITAL', value: fmtPct(roi),
        valueColor: pctColor(roi), sub: 'Holding: ' + fmtHold(holdMonths) },
    ];
    cells.forEach((c, i) => {
      const x = 54 + i * cellW;
      doc.roundedRect(x, heroY, cellW - 4, heroH, 3).fill(CREAM);
      drawHeroCell(doc, c, x, heroY, cellW - 4, heroH);
    });

    // ─── HOLDINGS TABLE ────────────────────────────────────────
    let y = heroY + heroH + 22;
    drawSectionLabel(doc, y, 'Holdings');
    y += 14;

    const cols = [
      { key: 'asset',    w: 80,  align: 'left',  title: 'Asset' },
      { key: 'custody',  w: 130, align: 'left',  title: 'Custody' },
      { key: 'qty',      w: 74,  align: 'right', title: 'Quantity' },
      { key: 'cbUnit',   w: 62,  align: 'right', title: 'Cost basis unit' },
      { key: 'cbTotal',  w: 68,  align: 'right', title: 'Cost basis total' },
      { key: 'px',       w: 62,  align: 'right', title: 'Price (snap.)' },
      { key: 'mv',       w: 68,  align: 'right', title: 'Market value' },
      { key: 'unreal',   w: 62,  align: 'right', title: 'P&L unrl.' },
      { key: 'pct',      w: 48,  align: 'right', title: '% vs cost' },
      { key: 'weight',   w: 42,  align: 'right', title: '% sleeve' },
    ];
    const tableW = cols.reduce((s, c) => s + c.w, 0);
    const startX = 54;

    // Header
    doc.rect(startX, y, tableW, 16).fill(NAVY);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(6.5);
    let cx = startX;
    for (const c of cols) {
      doc.text(c.title.toUpperCase(), cx + 3, y + 4,
        { width: c.w - 6, align: c.align, characterSpacing: 0.8, lineBreak: false });
      cx += c.w;
    }
    y += 16;

    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5);
    if (enriched.length === 0) {
      doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9)
         .text('No crypto positions.', startX + 8, y + 8,
               { width: tableW - 16, align: 'center' });
      y += 30;
    } else {
      enriched.forEach((p, idx) => {
        if (idx % 2 === 1) doc.rect(startX, y, tableW, 16).fill(ROW_ALT);
        const weight = totMarket > 0 ? p.marketUsd / totMarket : null;
        const assetLabel = (p.asset || '?') + (p.asset_name ? ` (${p.asset_name})` : '');
        const row = {
          asset: assetLabel,
          custody: p.custody || '—',
          qty: fmtQty(p.qty, 4),
          cbUnit: '$' + Number(p.cost_basis_unit_usd || 0).toFixed(4),
          cbTotal: fmtUSD(p.costBasis, 2),
          px: '$' + Number(p.priceLive || 0).toFixed(4),
          mv: fmtUSD(p.marketUsd, 2),
          unreal: (p.unrealUsd >= 0 ? '+' : '') + fmtUSD(Math.abs(p.unrealUsd), 2)
                   .replace('$', p.unrealUsd < 0 ? '-$' : '$'),
          pct: fmtPct(p.unrealPct),
          weight: weight != null ? (weight * 100).toFixed(2) + '%' : '—',
        };
        // Simpler unreal formatting
        row.unreal = (p.unrealUsd >= 0 ? '+' : '-') +
                     '$' + Math.abs(p.unrealUsd).toLocaleString('en-US', {
                       minimumFractionDigits: 2, maximumFractionDigits: 2 });

        cx = startX;
        for (const c of cols) {
          let color = NEAR_BLACK;
          let font = 'Helvetica';
          if (c.key === 'asset') font = 'Helvetica-Bold';
          if (c.key === 'unreal' || c.key === 'pct') {
            color = pctColor(p.unrealUsd);
            font = 'Helvetica-Bold';
          }
          doc.fillColor(color).font(font).fontSize(7)
             .text(String(row[c.key] ?? ''), cx + 3, y + 4,
                   { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true });
          cx += c.w;
        }
        y += 16;
      });

      // TOTAL row
      doc.rect(startX, y, tableW, 18).fill(CREAM);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5);
      const totRow = {
        asset: 'TOTAL', custody: '',
        qty: '', cbUnit: '',
        cbTotal: fmtUSD(totCost, 2),
        px: '',
        mv: fmtUSD(totMarket, 2),
        unreal: (totUnreal >= 0 ? '+' : '-') +
                '$' + Math.abs(totUnreal).toLocaleString('en-US', {
                  minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        pct: fmtPct(totCost > 0 ? totUnreal / totCost : null),
        weight: '100%',
      };
      cx = startX;
      for (const c of cols) {
        let color = NAVY;
        if (c.key === 'unreal' || c.key === 'pct') color = pctColor(totUnreal);
        doc.fillColor(color)
           .text(String(totRow[c.key] ?? ''), cx + 3, y + 5,
                 { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true });
        cx += c.w;
      }
      y += 18;
    }

    // ─── METHODOLOGICAL BASIS ──────────────────────────────────
    y += 12;
    drawSectionLabel(doc, y, 'Methodological basis');
    y += 12;
    doc.rect(startX, y, tableW, 74).fill(CREAM);
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5)
       .text(
         `Accounting method: ${crJson.accounting_method || '—'}. ` +
         `NAV (PDF) = Σ (quantity × snapshot price from the last cached mark). ` +
         `The web view overlays live spot prices from Crypto.com Exchange; this PDF uses the ` +
         `snapshot to stay well below the request timeout. ` +
         `Net capital contributed: fiat deposits ${fmtUSD(depositsFiat, 0)} − fiat withdrawals to bank ` +
         `${fmtUSD(Math.abs(withdrawalsFiat), 0)} = ${fmtUSD(capNeto, 0)}.`,
         startX + 8, y + 8,
         { width: tableW - 16, lineGap: 2 });

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5)
       .text('Historical realized P&L (2024 + Q1 2025): ', startX + 8, y + 50, { continued: true, lineBreak: false });
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5)
       .text(
         `${fmtUSD(crJson.realized_pnl_historico?.y2024_usd, 0)} (2024) + ` +
         `${fmtUSD(crJson.realized_pnl_historico?.y2025_q1_usd, 0)} (Q1 2025) ` +
         `= ${fmtUSD(realizedHist, 0)} net. Cristalizado y repatriado al sleeve Cash en banco; ` +
         `no integra el NAV del sleeve crypto vivo.`,
         { width: tableW - 16 - 190, lineBreak: false, ellipsis: true });

    drawFooter(doc, asOfStatic, 'crypto_positions.json (static snapshot)');
    doc.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  }
};
