// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Fixed Income (CDs) Snapshot PDF
// Server-side replica of `tab-fixedincome` in /performance.html.
// Data source: loadAndValueTimeDeposits() from api/_time-deposits.js
// One-page LETTER, DCE brand (NAVY + GOLD).
// ═══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { loadAndValueTimeDeposits } = require('./_time-deposits');
const { requireRole } = require('./_require-role');

const {
  NAVY, GOLD, GRAY, LIGHT, GREEN, RED, NEAR_BLACK, WHITE, CREAM, ROW_ALT,
  fmtUSD, fmtPct, fmtPctRaw, pctColor,
  drawHeaderBar, drawFooter, drawSectionLabel, drawHeroCell,
} = require('./_pdf-helpers');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const td = await loadAndValueTimeDeposits(today);
    const deps = (td.deposits || []).filter(d => d.status !== 'redeemed');
    const asOf = td.as_of || today;

    // ─── Aggregate KPIs ────────────────────────────────────────
    const totalPrincipal = deps.reduce((s, d) => s + Number(d.principal || 0), 0);
    const totalMv = deps.reduce((s, d) => s + Number(d.mv || 0), 0);
    const totalAccruedGross = deps.reduce((s, d) => s + Number(d.accrued_gross || 0), 0);
    const totalAccruedNet = deps.reduce((s, d) => s + Number(d.accrued_net || 0), 0);
    const totalAccruedTax = deps.reduce((s, d) => s + Number(d.accrued_tax || 0), 0);

    let wYieldNumer = 0, wYieldDenom = 0, terminalNet = 0;
    let maxMaturity = '';
    // Bank concentration & WAM (principal-weighted days remaining)
    const bankMap = new Map();
    let wamNumer = 0, wamDenom = 0;
    const ccySet = new Set();
    for (const d of deps) {
      const net = Number(d.annual_rate) * (1 - Number(d.tax_rate || 0));
      wYieldNumer += Number(d.principal) * net;
      wYieldDenom += Number(d.principal);
      terminalNet += Number(d.terminal_net || 0);
      if (d.maturity_date > maxMaturity) maxMaturity = d.maturity_date;
      const bnk = (d.bank || 'Unknown').trim();
      bankMap.set(bnk, (bankMap.get(bnk) || 0) + Number(d.principal || 0));
      wamNumer += Number(d.principal || 0) * Number(d.days_remaining || 0);
      wamDenom += Number(d.principal || 0);
      ccySet.add((d.currency || 'USD').toUpperCase());
    }
    const wYield = wYieldDenom > 0 ? wYieldNumer / wYieldDenom : null;
    const wamDays = wamDenom > 0 ? Math.round(wamNumer / wamDenom) : null;
    // Top-bank concentration string.
    const bankConc = [...bankMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, p]) => `${b} ${totalPrincipal > 0 ? ((p / totalPrincipal) * 100).toFixed(0) : '0'}%`)
      .slice(0, 3)
      .join(' · ');
    // Day-count convention (all deposits should use the same; report the mode).
    const convCount = new Map();
    for (const d of deps) {
      const c = d.day_count_convention || 'actual_365';
      convCount.set(c, (convCount.get(c) || 0) + 1);
    }
    const dominantConv = [...convCount.entries()].sort((a, b) => b[1] - a[1])[0];
    const conventionLabel = dominantConv ? (
      dominantConv[0] === 'actual_365' ? 'ACT/365' :
      dominantConv[0] === 'actual_360' ? 'ACT/360' :
      dominantConv[0] === '30_360'     ? '30/360'  :
      dominantConv[0]
    ) : 'ACT/365';

    // ─── Build PDF ─────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="DCE_BankDeposits_Snapshot_${today}.pdf"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    doc.pipe(res);

    const W = doc.page.width;
    drawHeaderBar(doc, 'Bank Deposits Snapshot');

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
       .text('Bank Deposits — Time deposits (CDs)', 54, 62);
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text(`Mark-to-accrual (carrying value) · ${deps.length} active deposit${deps.length === 1 ? '' : 's'} · as of ${asOf}`,
             54, 88);

    // ─── HERO STRIP (5 cells) ──────────────────────────────────
    const heroY = 110;
    const heroH = 62;
    const cellW = (W - 108) / 5;
    const cells = [
      { label: 'TOTAL PRINCIPAL', value: fmtUSD(totalPrincipal, 0),
        sub: `${deps.length} deposit${deps.length === 1 ? '' : 's'}` },
      { label: 'CARRYING VALUE (M2A)', value: fmtUSD(totalMv, 0), sub: `as of ${asOf}` },
      { label: 'ACCRUED (NET)', value: (totalAccruedNet >= 0 ? '+' : '') + fmtUSD(totalAccruedNet, 0),
        valueColor: pctColor(totalAccruedNet),
        sub: `gross ${fmtUSD(totalAccruedGross, 0)} - tax ${fmtUSD(totalAccruedTax, 0)}` },
      { label: 'WEIGHTED YIELD (NET)', value: fmtPctRaw(wYield, 3),
        sub: 'principal-weighted' },
      { label: 'NET INT. AT MATURITY', value: fmtUSD(terminalNet, 0),
        sub: deps.length > 0 && maxMaturity ? `at maturity ${maxMaturity}` : '—' },
    ];
    cells.forEach((c, i) => {
      const x = 54 + i * cellW;
      doc.roundedRect(x, heroY, cellW - 4, heroH, 3).fill(CREAM);
      drawHeroCell(doc, c, x, heroY, cellW - 4, heroH);
    });

    // ─── DEPOSITS TABLE ────────────────────────────────────────
    let y = heroY + heroH + 22;
    drawSectionLabel(doc, y, 'Deposits');
    y += 14;

    // Columns: Name | Bank | Principal | Start | Maturity | Rate (gross) | Tax | Net yield | Accrued (net) | MV | Progress % | Days rem | Status
    const cols = [
      { key: 'name',      w: 88, align: 'left',  title: 'Name' },
      { key: 'bank',      w: 62, align: 'left',  title: 'Bank' },
      { key: 'principal', w: 54, align: 'right', title: 'Principal' },
      { key: 'start',     w: 46, align: 'left',  title: 'Start' },
      { key: 'maturity',  w: 46, align: 'left',  title: 'Maturity' },
      { key: 'gross',     w: 40, align: 'right', title: 'Rate (gr.)' },
      { key: 'tax',       w: 32, align: 'right', title: 'Tax' },
      { key: 'netY',      w: 40, align: 'right', title: 'Net yield' },
      { key: 'accrued',   w: 52, align: 'right', title: 'Accrued (net)' },
      { key: 'mv',        w: 52, align: 'right', title: 'Carrying' },
      { key: 'pct',       w: 34, align: 'right', title: 'Prog.' },
      { key: 'daysRem',   w: 32, align: 'right', title: 'Days' },
      { key: 'status',    w: 40, align: 'left',  title: 'Status' },
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

    if (deps.length === 0) {
      doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(9)
         .text('No time deposits yet. Add one from Data & audit.',
               startX + 8, y + 8, { width: tableW - 16, align: 'center' });
      y += 30;
    } else {
      doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7.5);
      deps.forEach((d, idx) => {
        if (idx % 2 === 1) doc.rect(startX, y, tableW, 16).fill(ROW_ALT);
        const gross = Number(d.annual_rate);
        const tax = Number(d.tax_rate || 0);
        const netY = gross * (1 - tax);
        const pct = Number(d.pct_elapsed || 0);
        const row = {
          name: d.name || '',
          bank: d.bank || '',
          principal: fmtUSD(d.principal, 0),
          start: d.start_date,
          maturity: d.maturity_date,
          gross: fmtPctRaw(gross, 3),
          tax: (tax * 100).toFixed(0) + '%',
          netY: fmtPctRaw(netY, 3),
          accrued: fmtUSD(d.accrued_net, 2),
          mv: fmtUSD(d.mv, 2),
          pct: (pct * 100).toFixed(1) + '%',
          daysRem: String(d.days_remaining ?? '—'),
          status: d.is_matured || d.status === 'matured' ? 'matured' : 'active',
        };
        cx = startX;
        for (const c of cols) {
          let color = NEAR_BLACK;
          let font = 'Helvetica';
          if (c.key === 'name' || c.key === 'netY' || c.key === 'accrued') font = 'Helvetica-Bold';
          if (c.key === 'accrued') color = pctColor(d.accrued_net);
          if (c.key === 'status') color = row.status === 'matured' ? GRAY : GREEN;
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
      const totalRow = {
        name: 'TOTAL', bank: '',
        principal: fmtUSD(totalPrincipal, 0),
        start: '', maturity: '', gross: '', tax: '',
        netY: fmtPctRaw(wYield, 3),
        accrued: fmtUSD(totalAccruedNet, 0),
        mv: fmtUSD(totalMv, 0),
        pct: '', daysRem: '', status: '',
      };
      cx = startX;
      for (const c of cols) {
        let color = NAVY;
        if (c.key === 'accrued') color = pctColor(totalAccruedNet);
        doc.fillColor(color)
           .text(String(totalRow[c.key] ?? ''), cx + 3, y + 5,
                 { width: c.w - 6, align: c.align, lineBreak: false, ellipsis: true });
        cx += c.w;
      }
      y += 18;
    }

    // ─── MATURITY LADDER ────────────────────────────────────────
    if (deps.length > 0) {
      y += 12;
      drawSectionLabel(doc, y, 'Maturity ladder');
      y += 12;

      const ladderCols = [
        { key: 'maturity',  w: 60, align: 'left',  title: 'Maturity' },
        { key: 'deposit',   w: 180, align: 'left',  title: 'Deposit' },
        { key: 'principal', w: 80, align: 'right', title: 'Principal' },
        { key: 'interest',  w: 92, align: 'right', title: 'Interest at maturity' },
        { key: 'cashflow',  w: 92, align: 'right', title: 'Cash flow at maturity' },
        { key: 'daysRem',   w: 56, align: 'right', title: 'Days rem.' },
      ];
      const lW = ladderCols.reduce((s, c) => s + c.w, 0);
      // Header
      doc.rect(startX, y, lW, 16).fill(NAVY);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7);
      cx = startX;
      for (const c of ladderCols) {
        doc.text(c.title.toUpperCase(), cx + 4, y + 4,
          { width: c.w - 8, align: c.align, characterSpacing: 0.8, lineBreak: false });
        cx += c.w;
      }
      y += 16;

      const sorted = [...deps].sort((a, b) => (a.maturity_date || '').localeCompare(b.maturity_date || ''));
      let cumP = 0, cumI = 0;
      sorted.forEach((d, idx) => {
        if (idx % 2 === 1) doc.rect(startX, y, lW, 15).fill(ROW_ALT);
        const cf = Number(d.principal) + Number(d.terminal_net || 0);
        cumP += Number(d.principal);
        cumI += Number(d.terminal_net || 0);
        const row = {
          maturity: d.maturity_date || '—',
          deposit: `${d.bank || '—'} — ${d.name || ''}`,
          principal: fmtUSD(d.principal, 0),
          interest: fmtUSD(d.terminal_net, 2),
          cashflow: fmtUSD(cf, 2),
          daysRem: String(d.days_remaining ?? '—'),
        };
        cx = startX;
        for (const c of ladderCols) {
          let color = NEAR_BLACK;
          let font = 'Helvetica';
          if (c.key === 'maturity') font = 'Helvetica-Bold';
          if (c.key === 'interest') { color = GREEN; }
          if (c.key === 'cashflow') font = 'Helvetica-Bold';
          doc.fillColor(color).font(font).fontSize(7.5)
             .text(String(row[c.key] ?? ''), cx + 4, y + 3,
                   { width: c.w - 8, align: c.align, lineBreak: false, ellipsis: true });
          cx += c.w;
        }
        y += 15;
      });

      // TOTAL ladder row
      doc.rect(startX, y, lW, 17).fill(CREAM);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5);
      const tot = {
        maturity: 'TOTAL',
        deposit: '',
        principal: fmtUSD(cumP, 0),
        interest: fmtUSD(cumI, 2),
        cashflow: fmtUSD(cumP + cumI, 2),
        daysRem: '',
      };
      cx = startX;
      for (const c of ladderCols) {
        let color = NAVY;
        if (c.key === 'interest') color = GREEN;
        doc.fillColor(color)
           .text(String(tot[c.key] ?? ''), cx + 4, y + 5,
                 { width: c.w - 8, align: c.align, lineBreak: false, ellipsis: true });
        cx += c.w;
      }
      y += 17;
    }

    // ─── PORTFOLIO OPERATIONAL METRICS ─────────────────────────
    if (deps.length > 0) {
      y += 14;
      drawSectionLabel(doc, y, 'Portfolio metrics');
      y += 12;
      const opBoxH = 30;
      doc.rect(startX, y, tableW, opBoxH).fill(CREAM);
      const colTW = tableW / 3;
      doc.fillColor(NEAR_BLACK).font('Helvetica-Bold').fontSize(7.5)
         .text('Bank concentration', startX + 8, y + 6, { width: colTW - 16, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5)
         .text(bankConc || '—', startX + 8, y + 18, { width: colTW - 16, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold')
         .text('Weighted avg. maturity', startX + colTW + 8, y + 6, { width: colTW - 16, lineBreak: false });
      doc.font('Helvetica')
         .text(wamDays != null ? `${wamDays} days remaining` : '—', startX + colTW + 8, y + 18, { width: colTW - 16, lineBreak: false });
      doc.font('Helvetica-Bold')
         .text('Currency exposure', startX + (2 * colTW) + 8, y + 6, { width: colTW - 16, lineBreak: false });
      doc.font('Helvetica')
         .text([...ccySet].join(', ') + (ccySet.size === 1 ? ' 100%' : ''), startX + (2 * colTW) + 8, y + 18, { width: colTW - 16, lineBreak: false });
      y += opBoxH;
    }

    // ─── METHODOLOGICAL BASIS ──────────────────────────────────
    if (deps.length > 0) {
      y += 10;
      drawSectionLabel(doc, y, 'Methodological basis');
      y += 12;
      const methBoxH = 46;
      doc.rect(startX, y, tableW, methBoxH).fill(CREAM);
      doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(7)
         .text(
           `Day-count: ${conventionLabel} (calendar days, inclusive of start, exclusive of maturity). ` +
           `Progress % and accrued interest use the same day count, so daily accrual is reproducible and reconciles to carrying value. ` +
           `Mark-to-accrual: carrying value = principal + accrued net interest. This is NOT a market quote (deposits are not traded) — it is the linear accrual value.`,
           startX + 8, y + 5,
           { width: tableW - 16, lineGap: 2 });
      doc.text(
           `Tax recognition: the 10% withholding is accrued proportionally each day (accrued_tax = accrued_gross × tax_rate), not deferred to maturity. The Accrued (net) figure already reflects daily tax withholding.`,
           startX + 8, y + 30,
           { width: tableW - 16, lineGap: 2 });
      y += methBoxH;
    }

    drawFooter(doc, asOf, 'time_deposits table (Supabase) · mark-to-accrual');
    doc.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  }
};
