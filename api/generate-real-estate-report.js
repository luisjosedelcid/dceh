// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Real Estate Snapshot PDF
// Server-side replica of the `tab-realestate` view in /performance.html
// One-page LETTER, DCE brand (NAVY + GOLD).
// Data source: /public/real_estate_positions.json (AX Partners mark).
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { requireRole } = require('./_require-role');

const {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtUSDSigned, fmtPct, fmtPctRaw, fmtMoic, fmtEUR, fmtNum, pctColor,
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

// ── XIRR helper (bisection over cashflows) ────────────────────────
function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const dates = cashflows.map(c => new Date(c.date));
  const amounts = cashflows.map(c => Number(c.amount));
  const t0 = dates[0].getTime();
  const yrs = dates.map(d => (d.getTime() - t0) / (365.25 * 86400_000));
  const npv = (rate) => amounts.reduce((s, a, i) => s + a / Math.pow(1 + rate, yrs[i]), 0);
  let lo = -0.9999, hi = 10;
  let fLo = npv(lo), fHi = npv(hi);
  if (fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-8) return mid;
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

function monthsBetween(d1YMD, d2YMD) {
  const a = new Date(d1YMD), b = new Date(d2YMD);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
function fmtMonths(months) {
  if (months == null || isNaN(months) || months <= 0) return '—';
  const y = Math.floor(months / 12), m = Math.round(months % 12);
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} ${y === 1 ? 'yr' : 'yrs'}`;
  return `${y}y ${m}m`;
}

// ─── Handler ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const reJson = readPublicJson('real_estate_positions.json');
    if (!reJson) {
      res.status(500).json({ error: 'real_estate_positions.json not found' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const fxToday = Number(reJson.fx_eur_usd?.today || 1);
    const fxTodayDate = reJson.fx_eur_usd?.today_date || '—';
    const fxNav = Number(reJson.fx_eur_usd?.nav_close || fxToday);
    const positions = Array.isArray(reJson.positions) ? reJson.positions : [];

    // Enrich each position (mirrors performance.html reLoadEnriched logic).
    const enriched = positions.map(p => {
      const costUsd = Number(p.amount_eur) * Number(p.fx_eur_usd_at_deploy);
      const navUsdToday = Number(p.nav_eur) * fxToday;
      const moicEur = Number(p.nav_eur) / Number(p.amount_eur);
      const moicUsd = navUsdToday / costUsd;
      const deployDate = p.deployment_date;
      const tYears = (new Date(today) - new Date(deployDate)) / (365.25 * 86400_000);
      const irrUsd = tYears > 0 ? Math.pow(moicUsd, 1 / tYears) - 1 : null;
      const irrEur = tYears > 0 ? Math.pow(moicEur, 1 / tYears) - 1 : null;
      // Lockup logic — use midpoint of low/high if pair, else single value.
      const lockLow = Number(p.target_investment_period_months_low || 0);
      const lockHigh = Number(p.target_investment_period_months_high || lockLow || 0);
      const lockTotal = lockHigh > 0 ? (lockLow + lockHigh) / 2 : 0;
      const monthsElapsed = monthsBetween(deployDate, today);
      const lockupRem = Math.max(0, lockTotal - monthsElapsed);
      return Object.assign({}, p, {
        deployDate, costUsd, navUsdToday, moicEur, moicUsd, irrUsd, irrEur, lockupRem,
      });
    });

    const totInvUsd = enriched.reduce((s, p) => s + p.costUsd, 0);
    const totNavUsd = enriched.reduce((s, p) => s + p.navUsdToday, 0);
    const totNavEur = enriched.reduce((s, p) => s + Number(p.nav_eur), 0);
    const totInvEur = enriched.reduce((s, p) => s + Number(p.amount_eur), 0);
    const totMoicUsd = totInvUsd > 0 ? totNavUsd / totInvUsd : null;
    const totMoicEur = totInvEur > 0 ? totNavEur / totInvEur : null;
    const cfs = enriched.map(p => ({ date: p.deployDate, amount: -p.costUsd }));
    cfs.push({ date: today, amount: totNavUsd });
    const totIrrUsd = xirr(cfs);
    const navGainUsd = totNavUsd - totInvUsd;
    const navGainPct = totInvUsd > 0 ? navGainUsd / totInvUsd : null;

    // ─── Build PDF ───────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="DCE_RealEstate_Snapshot_${today}.pdf"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;

    drawHeaderBar(doc, 'Real Estate Snapshot');

    // Title
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
       .text('Real Estate — Active positions', 54, 62);
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(`AX Partners aggregate · NAV mark ${reJson.nav_as_of || '—'} · FX EUR/USD ${fxToday.toFixed(4)} (${fxTodayDate})`,
             54, 88);

    // ─── HERO STRIP (5 cells) ──────────────────────────────────
    const heroY = 110;
    const heroH = 62;
    const cellW = (W - 108) / 5;
    const cells = [
      { label: 'NET INVESTED (USD)', value: fmtUSD(totInvUsd, 0), sub: '@ FX deploy' },
      { label: 'NAV (USD)', value: fmtUSD(totNavUsd, 0),
        sub: (navGainUsd >= 0 ? '+' : '') + fmtUSD(navGainUsd, 0) +
             ' (' + (navGainPct != null ? fmtPctRaw(navGainPct, 2) : '—') + ')',
        subColor: pctColor(navGainUsd) },
      { label: 'MOIC (USD)', value: fmtMoic(totMoicUsd),
        valueColor: totMoicUsd != null && totMoicUsd >= 1 ? GREEN : RED,
        sub: 'portfolio aggregate' },
      { label: 'XIRR (USD, ann.)', value: fmtPct(totIrrUsd),
        valueColor: pctColor(totIrrUsd), sub: 'since inception' },
      { label: 'POSITIONS', value: String(enriched.length),
        sub: 'NAV EUR: ' + fmtEUR(totNavEur, 0) },
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

    // Columns: Position | Vehicle | Deploy | Aporte EUR | FX depl. | Cost USD | NAV EUR | NAV USD | MOIC USD | IRR USD | Weight | Lockup rem
    const cols = [
      { key: 'name',       w: 92, align: 'left',  title: 'Position' },
      { key: 'vehicle',    w: 78, align: 'left',  title: 'Vehicle' },
      { key: 'deployDate', w: 52, align: 'left',  title: 'Deploy' },
      { key: 'aporteEur',  w: 46, align: 'right', title: 'Aporte EUR' },
      { key: 'fxDeploy',   w: 34, align: 'right', title: 'FX depl.' },
      { key: 'costUsd',    w: 48, align: 'right', title: 'Cost USD' },
      { key: 'navEur',     w: 46, align: 'right', title: 'NAV EUR' },
      { key: 'navUsd',     w: 46, align: 'right', title: 'NAV USD' },
      { key: 'moicUsd',    w: 32, align: 'right', title: 'MOIC USD' },
      { key: 'irrUsd',     w: 38, align: 'right', title: 'IRR USD' },
      { key: 'weight',     w: 30, align: 'right', title: 'Wt.' },
      { key: 'lockup',     w: 34, align: 'right', title: 'Lockup' },
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

    // Body
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5);
    enriched.forEach((p, idx) => {
      if (idx % 2 === 1) doc.rect(startX, y, tableW, 16).fill(ROW_ALT);
      const weight = totNavUsd > 0 ? p.navUsdToday / totNavUsd : null;
      const irrCls = p.irrUsd != null && p.irrUsd >= 0 ? GREEN : RED;
      const moicCls = p.moicUsd >= 1 ? GREEN : RED;

      const row = {
        name: p.name || '—',
        vehicle: p.vehicle || '—',
        deployDate: p.deployment_date || '—',
        aporteEur: fmtEUR(p.amount_eur, 0),
        fxDeploy: Number(p.fx_eur_usd_at_deploy || 0).toFixed(4),
        costUsd: fmtUSD(p.costUsd, 0),
        navEur: fmtEUR(p.nav_eur, 0),
        navUsd: fmtUSD(p.navUsdToday, 0),
        moicUsd: fmtMoic(p.moicUsd),
        irrUsd: fmtPct(p.irrUsd),
        weight: weight != null ? (weight * 100).toFixed(1) + '%' : '—',
        lockup: fmtMonths(p.lockupRem),
      };
      cx = startX;
      for (const c of cols) {
        let color = NEAR_BLACK;
        if (c.key === 'moicUsd') color = moicCls;
        else if (c.key === 'irrUsd') color = irrCls;
        doc.fillColor(color)
           .font(c.key === 'name' ? 'Helvetica-Bold' : (c.key === 'moicUsd' || c.key === 'irrUsd' ? 'Helvetica-Bold' : 'Helvetica'))
           .fontSize(c.key === 'name' ? 7.5 : 7)
           .text(String(row[c.key] ?? '—'), cx + 3, y + 4,
                 { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true });
        cx += c.w;
      }
      y += 16;
    });

    // TOTAL row
    doc.rect(startX, y, tableW, 18).fill(CREAM);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5);
    const totalRow = {
      name: 'TOTAL',
      vehicle: '',
      deployDate: '',
      aporteEur: fmtEUR(totInvEur, 0),
      fxDeploy: '',
      costUsd: fmtUSD(totInvUsd, 0),
      navEur: fmtEUR(totNavEur, 0),
      navUsd: fmtUSD(totNavUsd, 0),
      moicUsd: fmtMoic(totMoicUsd),
      irrUsd: fmtPct(totIrrUsd),
      weight: '100%',
      lockup: '',
    };
    cx = startX;
    for (const c of cols) {
      let color = NAVY;
      if (c.key === 'irrUsd') color = pctColor(totIrrUsd);
      else if (c.key === 'moicUsd') color = totMoicUsd != null && totMoicUsd >= 1 ? GREEN : RED;
      doc.fillColor(color)
         .text(String(totalRow[c.key] ?? ''), cx + 3, y + 5,
               { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true });
      cx += c.w;
    }
    y += 18;

    // ─── METHODOLOGICAL BASIS ──────────────────────────────────
    y += 12;
    drawSectionLabel(doc, y, 'Methodological basis');
    y += 12;
    doc.rect(startX, y, tableW, 60).fill(CREAM);
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5)
       .text(
         `FX EUR/USD used: ${fxToday.toFixed(4)} on ${fxTodayDate} (NAV mark on ${reJson.nav_as_of} at ${fxNav.toFixed(4)}). ` +
         `Each contribution was converted to USD at the FX in effect on deployment date; current NAV is converted at today's FX. ` +
         `XIRR USD calculated by bisection over individual cashflows (deployment negative, aggregate NAV positive today).`,
         startX + 8, y + 8,
         { width: tableW - 16, lineGap: 2 });
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(7)
       .text(reJson.disclaimer || '',
             startX + 8, y + 42,
             { width: tableW - 16, lineGap: 2, height: 18, ellipsis: true });

    drawFooter(doc, today, `real_estate_positions.json · ${reJson.source || 'AX Partners'}`);
    doc.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  }
};
