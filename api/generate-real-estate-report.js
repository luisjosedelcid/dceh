// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Real Estate Snapshot PDF
// Server-side replica of the `tab-realestate` view in /performance.html
// One-page LETTER, DCE brand (NAVY + GOLD).
// Data source: /public/real_estate_positions.json (AX Partners mark).
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { requireCapability } = require('./_require-capability');

const {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtUSDSigned, fmtPct, fmtPctRaw, fmtMoic, fmtEUR, fmtNum, pctColor,
  drawHeaderBar, drawFooter, drawSectionLabel, drawHeroCell,
} = require('./_pdf-helpers');
const { getFxRate, getFxRateOnDate } = require('./_fx-rates');
const { resolveRealEstateAsOf } = require('./_real-estate-marks');

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
    const auth = await requireCapability(req, 'RP-05');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const staticJson = readPublicJson('real_estate_positions.json');
    if (!staticJson) {
      res.status(500).json({ error: 'real_estate_positions.json not found' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    // Requested as-of date via ?as_of=YYYY-MM-DD; clamp future dates to today.
    // If missing or malformed we default to today (matches the UI default).
    const rawAsOf = (req.query && req.query.as_of) ? String(req.query.as_of) : today;
    const asOfRequested =
      /^\d{4}-\d{2}-\d{2}$/.test(rawAsOf) ? (rawAsOf > today ? today : rawAsOf) : today;

    // Resolve the mark that applies at as-of. This overrides nav_as_of, source,
    // and each position's nav_eur / moic_eur_reported / gp_commentary with the
    // most recent published mark <= as-of. Positions with no prior mark fall
    // back to par (NAV = capital contributed).
    const reJson = await resolveRealEstateAsOf(staticJson, asOfRequested);
    const navAsOf = reJson.nav_as_of || '\u2014';
    // Filter out positions not yet deployed as of the requested date.
    const positions = (Array.isArray(reJson.positions) ? reJson.positions : [])
      .filter(p => p._mark_status !== 'pre_deploy');
    if (positions.length === 0) {
      res.status(400).json({ error: `No Real Estate positions deployed as of ${asOfRequested}.` });
      return;
    }

    // ── Live FX (ECB via Frankfurter, 60-min cache) with file fallback ──
    // fxToday: rate at report generation (latest published ECB reference).
    // fxNav:   rate on the NAV mark date (historical ECB reference).
    // If either live call fails we fall back to whatever is in the JSON so
    // the PDF still renders \u2014 the source label makes the fallback visible.
    const fxTodayFallback = {
      value: Number(reJson.fx_eur_usd?.today || 0),
      date:  reJson.fx_eur_usd?.today_date || null,
      source: 'real_estate_positions.json (cached)',
    };
    const fxNavFallback = {
      value: Number(reJson.fx_eur_usd?.nav_close || reJson.fx_eur_usd?.today || 0),
      date:  reJson.fx_eur_usd?.nav_close_date || null,
      source: 'real_estate_positions.json (cached)',
    };
    // Historical snapshots must NOT use a live FX quote dated after the
    // requested as-of date. For a snapshot at 2026-07-31 the "indicative"
    // NAV-to-USD translation must use the FX rate ON 2026-07-31, not today.
    // Detect the historical case and route both quotes through
    // getFxRateOnDate. Only when as_of == today do we hit the live endpoint.
    const isHistoricalReport = asOfRequested < today;
    const [fxTodayInfo, fxNavInfo] = await Promise.all([
      isHistoricalReport
        ? getFxRateOnDate(asOfRequested, 'EUR', 'USD', { fallback: fxTodayFallback })
        : getFxRate('EUR', 'USD', { fallback: fxTodayFallback }),
      /^\d{4}-\d{2}-\d{2}$/.test(navAsOf)
        ? getFxRateOnDate(navAsOf, 'EUR', 'USD', { fallback: fxNavFallback })
        : Promise.resolve({ value: fxNavFallback.value || 1, date: null, source: fxNavFallback.source, cached: false, stale: true }),
    ]);
    const fxToday     = Number(fxTodayInfo.value) || 1;
    const fxTodayDate = fxTodayInfo.date || today;
    const fxTodaySrc  = fxTodayInfo.source || '\u2014';
    const fxNav       = Number(fxNavInfo.value) || fxToday;
    const fxNavDate   = fxNavInfo.date || navAsOf;
    const fxNavSrc    = fxNavInfo.source || '\u2014';

    // Enrich each position (mirrors performance.html reLoadEnriched logic).
    // Methodology (post-review): the GP NAV mark is dated `navAsOf` (typically
    // year-end). The FX quote is dated `fxTodayDate` (typically stale by a few
    // months). Terminal date of the XIRR must equal the NAV mark date, not
    // today, otherwise we would let calendar time erode the IRR against a
    // frozen NAV. We therefore compute XIRR in two dimensions:
    //   \u2022 EUR XIRR      \u2192 economic return of the asset (no FX effect)
    //   \u2022 USD XIRR      \u2192 economic return + FX effect, in USD terms
    //     terminal date = navAsOf, terminal FX = fxNav (NAV-close FX).
    // The USD figure shown in the hero is INDICATIVE: same GP NAV re-valued at
    // the most recent FX quote we have on file (dated fxTodayDate). This keeps
    // the mark auditable and makes the FX date honest.
    const enriched = positions.map(p => {
      const costUsdAtDeploy = Number(p.amount_eur) * Number(p.fx_eur_usd_at_deploy);
      // NAV in USD at NAV-close FX (economic USD value at the mark date).
      const navUsdAtMark = Number(p.nav_eur) * fxNav;
      // NAV in USD at latest available FX (indicative current value).
      const navUsdIndicative = Number(p.nav_eur) * fxToday;
      const moicEur = Number(p.nav_eur) / Number(p.amount_eur);
      const moicUsdAtMark = navUsdAtMark / costUsdAtDeploy;
      const moicUsdIndicative = navUsdIndicative / costUsdAtDeploy;
      const deployDate = p.deployment_date;
      // Years from deploy to NAV-close date (economic horizon).
      const tYearsToMark = (new Date(navAsOf) - new Date(deployDate)) / (365.25 * 86400_000);
      const irrEurToMark = tYearsToMark > 0 ? Math.pow(moicEur, 1 / tYearsToMark) - 1 : null;
      const irrUsdToMark = tYearsToMark > 0 ? Math.pow(moicUsdAtMark, 1 / tYearsToMark) - 1 : null;
      // Lockup semantics fix: this is the EXPECTED REMAINING TERM to exit,
      // computed as (midpoint of GP target investment period) minus months
      // elapsed since deployment. Show 0 if past the upper bound.
      const lockLow = Number(p.target_investment_period_months_low || 0);
      const lockHigh = Number(p.target_investment_period_months_high || lockLow || 0);
      const lockTotal = lockHigh > 0 ? (lockLow + lockHigh) / 2 : 0;
      const monthsElapsed = monthsBetween(deployDate, asOfRequested);
      const remainingTerm = Math.max(0, lockTotal - monthsElapsed);
      return Object.assign({}, p, {
        deployDate,
        costUsd: costUsdAtDeploy,
        // Preserve legacy field name for the row rendering.
        navUsdToday: navUsdIndicative,
        navUsdAtMark,
        moicEur,
        moicUsd: moicUsdIndicative,
        moicUsdAtMark,
        irrEur: irrEurToMark,
        irrUsd: irrUsdToMark,
        lockupRem: remainingTerm,
      });
    });

    const totInvUsd  = enriched.reduce((s, p) => s + p.costUsd, 0);
    const totNavUsdIndicative = enriched.reduce((s, p) => s + p.navUsdToday, 0);
    const totNavUsdAtMark     = enriched.reduce((s, p) => s + p.navUsdAtMark, 0);
    const totNavEur = enriched.reduce((s, p) => s + Number(p.nav_eur), 0);
    const totInvEur = enriched.reduce((s, p) => s + Number(p.amount_eur), 0);
    const totMoicUsdIndicative = totInvUsd > 0 ? totNavUsdIndicative / totInvUsd : null;
    const totMoicUsdAtMark     = totInvUsd > 0 ? totNavUsdAtMark / totInvUsd : null;
    const totMoicEur           = totInvEur > 0 ? totNavEur / totInvEur : null;
    // Portfolio EUR XIRR: cashflows in EUR, terminal date = navAsOf.
    const cfsEur = enriched.map(p => ({ date: p.deployDate, amount: -Number(p.amount_eur) }));
    cfsEur.push({ date: navAsOf, amount: totNavEur });
    const totIrrEur = xirr(cfsEur);
    // Portfolio USD XIRR (asset return + FX effect), terminal at navAsOf.
    const cfsUsdMark = enriched.map(p => ({ date: p.deployDate, amount: -p.costUsd }));
    cfsUsdMark.push({ date: navAsOf, amount: totNavUsdAtMark });
    const totIrrUsdAtMark = xirr(cfsUsdMark);
    // NAV gain in USD at the mark FX (auditable) and indicative (headline).
    const navGainUsdAtMark = totNavUsdAtMark - totInvUsd;
    const navGainUsdIndicative = totNavUsdIndicative - totInvUsd;
    const navGainPctIndicative = totInvUsd > 0 ? navGainUsdIndicative / totInvUsd : null;
    // FX effect on the aggregate mark, in USD.
    const fxEffectUsd = totNavUsdIndicative - totNavUsdAtMark;
    // Legacy aliases so subsequent code (rows/total row) keeps compiling.
    const totNavUsd  = totNavUsdIndicative;
    const totMoicUsd = totMoicUsdIndicative;
    const totIrrUsd  = totIrrUsdAtMark;
    const navGainUsd = navGainUsdIndicative;
    const navGainPct = navGainPctIndicative;

    // ─── Build PDF ───────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="DCE_RealEstate_Snapshot_${asOfRequested}.pdf"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;

    drawHeaderBar(doc, 'Real Estate Snapshot');

    // Title
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
       .text('Real Estate \u2014 Active positions', 54, 62);
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(
         `AX Partners aggregate  \u00b7  Latest GP NAV mark: ${navAsOf}  \u00b7  ` +
         `Converted to USD at FX EUR/USD ${fxToday.toFixed(4)} dated ${fxTodayDate} \u00b7 ${fxTodaySrc}`,
         54, 88);

    // ─── HERO STRIP (5 cells) ──────────────────────────────────
    const heroY = 110;
    const heroH = 62;
    const cellW = (W - 108) / 5;
    const cells = [
      { label: 'NET INVESTED (USD)', value: fmtUSD(totInvUsd, 0),
        sub: 'at FX on deploy' },
      { label: 'INDICATIVE NAV (USD)', value: fmtUSD(totNavUsdIndicative, 0),
        sub: (navGainUsdIndicative >= 0 ? '+' : '') + fmtUSD(navGainUsdIndicative, 0) +
             ' (' + (navGainPctIndicative != null ? fmtPctRaw(navGainPctIndicative, 2) : '\u2014') + ')',
        subColor: pctColor(navGainUsdIndicative) },
      { label: 'NAV / INVESTED (USD)', value: fmtMoic(totMoicUsdIndicative),
        valueColor: totMoicUsdIndicative != null && totMoicUsdIndicative >= 1 ? GREEN : RED,
        sub: 'residual multiple; no distributions yet' },
      { label: 'INDICATIVE XIRR (USD, ann.)', value: fmtPct(totIrrUsdAtMark),
        valueColor: pctColor(totIrrUsdAtMark),
        sub: `to ${navAsOf}` },
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

    // Columns: Position | Vehicle | Deploy | Contrib EUR | FX depl. | Cost USD | NAV EUR | NAV USD | NAV/Inv | IRR USD | Weight | Est. exit
    // Widths tuned so numeric columns don't wrap. Total: 504pt (letter usable).
    const cols = [
      { key: 'name',       w: 70, align: 'left',  title: 'Position' },
      { key: 'vehicle',    w: 54, align: 'left',  title: 'Vehicle' },
      { key: 'deployDate', w: 44, align: 'left',  title: 'Deploy' },
      { key: 'aporteEur',  w: 48, align: 'right', title: 'Contrib EUR' },
      { key: 'fxDeploy',   w: 28, align: 'right', title: 'FX depl.' },
      { key: 'costUsd',    w: 40, align: 'right', title: 'Cost USD' },
      { key: 'navEur',     w: 40, align: 'right', title: 'NAV EUR' },
      { key: 'navUsd',     w: 40, align: 'right', title: 'NAV USD' },
      { key: 'moicUsd',    w: 36, align: 'right', title: 'NAV/Inv' },
      { key: 'irrUsd',     w: 32, align: 'right', title: 'IRR USD' },
      { key: 'weight',     w: 30, align: 'right', title: 'Wt.' },
      { key: 'lockup',     w: 42, align: 'right', title: 'Est. exit' },
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

    // ─── METHODOLOGICAL BASIS ──────────────────────────
    y += 12;
    drawSectionLabel(doc, y, 'Methodological basis');
    y += 12;
    const methBoxH = 108;
    doc.rect(startX, y, tableW, methBoxH).fill(CREAM);
    // Sign for the FX-effect figure (ASCII hyphen-minus so pdfkit's built-in
    // WinAnsi font handles it \u2014 no glyph fallback boxes).
    const fxEffectSign = fxEffectUsd >= 0 ? '+' : '-';
    const fxEffectAbsStr = fmtUSD(Math.abs(fxEffectUsd), 0);
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5)
       .text(
         `Dates. Latest official GP NAV mark: ${navAsOf}. FX EUR/USD used to convert that NAV to USD (indicative): ` +
         `${fxToday.toFixed(4)} dated ${fxTodayDate} (${fxTodaySrc}). ` +
         `FX at the NAV-close date: ${fxNav.toFixed(4)} dated ${fxNavDate} (${fxNavSrc}). Report generated ${today}.`,
         startX + 8, y + 6,
         { width: tableW - 16, lineGap: 2 });
    doc.text(
         `NAV in USD. Contributions were converted to USD at the FX in effect on each deployment date. ` +
         `The "Indicative NAV (USD)" figure re-values the GP NAV at the latest ECB reference FX rate; ` +
         `it is NOT a fresh valuation. When the GP publishes its next semi-annual mark the number will move.`,
         startX + 8, y + 30,
         { width: tableW - 16, lineGap: 2 });
    doc.text(
         `XIRR. Aggregate portfolio IRR is calculated by bisection over individual cashflows: each deployment ` +
         `is a negative flow on its actual date; the terminal positive flow is the GP NAV dated ${navAsOf} ` +
         `(converted at NAV-close FX for the USD version) \u2014 NOT dated today, so calendar time cannot erode ` +
         `the IRR against a stale mark. EUR XIRR (asset economics, no FX effect): ${fmtPct(totIrrEur)}. ` +
         `USD XIRR (asset + FX to ${navAsOf}): ${fmtPct(totIrrUsdAtMark)}. ` +
         `FX effect on the aggregate mark (indicative NAV minus NAV at close FX): ` +
         `${fxEffectSign}${fxEffectAbsStr}.`,
         startX + 8, y + 60,
         { width: tableW - 16, lineGap: 2 });
    doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(6.8)
       .text(
         'GP mark policy. AX Partners publishes marks semi-annually (S1 mid-year, S2 year-end). ' +
         'Interim months do not produce a fresh mark. The EUR appreciation vs. contributed capital ' +
         '(' + (totInvEur > 0 ? ((totNavEur / totInvEur - 1) * 100).toFixed(1) : '\u2014') + '% aggregate at ' + navAsOf + ') reflects the GP\u0027s current model-based valuation ' +
         'and preferred-equity accruals, not a realised gain \u2014 final upside is recognised at exit. ' +
         'Next official mark expected with the S2 2026 report.',
         startX + 8, y + methBoxH - 24,
         { width: tableW - 16, lineGap: 2 });

    drawFooter(doc, asOfRequested,
      `real_estate_positions.json + real_estate_marks (as of ${asOfRequested})  \u00b7  ${reJson.source || 'AX Partners'}`);
    doc.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  }
};
