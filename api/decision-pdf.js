// GET /api/decision-pdf?id=<id>[&_tok=<admin>]
//
// Generates a branded PDF (DCE NAVY/GOLD) of a single Decision Journal entry,
// suitable for archival in the Data Room or sharing with the committee.
//
// Auth: any authenticated user (read-only). Admin token may be passed via
//   x-admin-token header OR the _tok query string (so a plain <a> link from
//   the journal detail row works as an in-browser view).
//
// Response: Content-Disposition: inline  ← opens in a new tab like the other
//   dashboard PDFs (Company Brief, Thesis Builder, etc.), not as a download.

'use strict';

const PDFDocument = require('pdfkit');
const { sbSelect } = require('./_supabase');
const { verifyAdminToken } = require('./_admin-auth');

// Brand
const NAVY = '#1B2642';
const GOLD = '#B88B47';
const GRAY_TXT = '#606060';
const GRAY_MID = '#8a9098';
const RULE = '#e8e6e0';
const CREAM = '#F5F1EB';
const NEAR_BLACK = '#0d0d0d';
const GREEN = '#2A7A56';
const RED = '#9B2335';
const AMBER = '#C19534';

const TYPE_COLORS = {
  BUY:    { fill: '#e3f4ea', text: '#1e6c3a' },
  ADD:    { fill: '#e3f4ea', text: '#1e6c3a' },
  SELL:   { fill: '#fbd7dd', text: '#7a1424' },
  TRIM:   { fill: '#fde3cf', text: '#7a3a08' },
  HOLD:   { fill: '#f0efec', text: '#5a5a5a' },
  PASS:   { fill: '#eef1f7', text: '#3a4460' },
  FOLLOW: { fill: '#fff3cf', text: '#7c5d10' },
};

module.exports = async (req, res) => {
  try {
    const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
    if (!ADMIN_TOKEN_SECRET) {
      res.setHeader('content-type', 'application/json');
      res.status(500).end(JSON.stringify({ ok: false, error: 'Server not configured' }));
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const token = ((req.headers['x-admin-token'] || url.searchParams.get('_tok') || '') + '').trim();
    if (!token) {
      res.setHeader('content-type', 'application/json');
      res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized: missing token' }));
      return;
    }
    const verified = verifyAdminToken(token, ADMIN_TOKEN_SECRET);
    if (!verified || !verified.email) {
      res.setHeader('content-type', 'application/json');
      res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized: invalid token' }));
      return;
    }
    const users = await sbSelect(
      'admin_users',
      `select=email,is_active&email=eq.${encodeURIComponent(verified.email)}&is_active=eq.true&limit=1`
    );
    if (!users[0]) {
      res.setHeader('content-type', 'application/json');
      res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized: user not found or inactive' }));
      return;
    }

    const id = Number(url.searchParams.get('id'));
    if (!id) {
      res.setHeader('content-type', 'application/json');
      res.status(400).end(JSON.stringify({ ok: false, error: 'id required' }));
      return;
    }

    const rows = await sbSelect('decision_journal', `select=*&id=eq.${id}&limit=1`);
    if (rows.length === 0) {
      res.setHeader('content-type', 'application/json');
      res.status(404).end(JSON.stringify({ ok: false, error: 'entry not found' }));
      return;
    }
    const r = rows[0];
    // PASS decisions do not open a position, so they carry no reviews,
    // executions, catalysts, pre-mortem, pillars or expected-return matrix.
    // A PASS PDF is: thesis (why declined) + notes.
    const isPass = String(r.decision_type || '').toUpperCase() === 'PASS';
    // The modal appends notes onto the thesis as "\n\n— Notes —\n...";
    // split them back out so the PDF can render them under their own label.
    let thesisMain = r.thesis || '';
    let notesTail = '';
    const notesSep = '\n\n— Notes —\n';
    const sepIdx = thesisMain.indexOf(notesSep);
    if (sepIdx >= 0) {
      notesTail = thesisMain.slice(sepIdx + notesSep.length).trim();
      thesisMain = thesisMain.slice(0, sepIdx).trim();
    }

    // Build PDF
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
      info: {
        Title: `DCE Holdings — Decision ${r.ticker} ${r.decision_type} ${r.decision_date}`,
        Author: 'DCE Holdings Investment Office',
      },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));

    const W = doc.page.width;
    const M = 54;
    const CW = W - M * 2;

    // ─── HEADER BAR ───────────────────────────────────────────────
    doc.rect(0, 0, W, 40).fill(NAVY);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
       .text('DCE HOLDINGS  ·  INVESTMENT OFFICE', M, 14, { lineBreak: false });
    doc.fillColor(GOLD).font('Helvetica').fontSize(9)
       .text('Decision Journal', M, 14, { width: CW, align: 'right' });

    let y = 70;

    // Section label
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('INVESTMENT DECISION', M, y);
    y += 14;

    // Title
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22)
       .text(`${r.ticker}  ·  ${r.decision_type}`, M, y);
    y += 32;

    // Meta grid (3 cells)
    const metaCells = [
      { k: 'DATE',  v: fmtDate(r.decision_date) },
      { k: 'PRICE', v: fmtPrice(r.price_at_decision) },
      { k: 'TYPE',  v: r.decision_type || '—' },
    ];
    const cellW = (CW - 8) / 3;
    metaCells.forEach((c, i) => {
      const x = M + i * (cellW + 4);
      doc.rect(x, y, cellW, 50).fill(CREAM);
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
         .text(c.k, x + 10, y + 8);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12)
         .text(c.v || '—', x + 10, y + 22, { width: cellW - 20, ellipsis: true, lineBreak: false });
    });
    y += 60;

    // Type badge (colored)
    const tc = TYPE_COLORS[r.decision_type] || { fill: '#eef1f7', text: '#3a4460' };
    if (r.framework_version === 'v3.2') {
      doc.font('Helvetica-Bold').fontSize(9);
      const label = 'FRAMEWORK v3.2';
      const w = doc.widthOfString(label) + 20;
      doc.roundedRect(M, y, w, 20, 3).fill(GOLD);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
         .text(label, M + 10, y + 5, { lineBreak: false, width: w - 20 });
      y += 28;
    }

    // Linked holding (if any)
    if (r.linked_holding) {
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
         .text('LINKED HOLDING', M, y);
      y += 12;
      doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(11)
         .text(String(r.linked_holding), M, y);
      y += 22;
    }

    // Thesis — note we use thesisMain (notes stripped) so the PASS layout
    // gets its own Notes block below.
    y = drawQA(doc, y, M, CW, isPass ? 'THESIS (WHY DECLINED)'
                              : r.decision_type === 'SELL' ? 'EXIT THESIS (WHY NOW)'
                              : 'INVESTMENT THESIS', thesisMain);

    // Notes (surfaces for every type when present, but this is the ONLY
    // extra content PASS gets — no reviews, executions, catalysts, pre-mortem).
    if (notesTail) {
      y = drawQA(doc, y, M, CW, 'NOTES', notesTail);
    }

    // v3.2 blocks (if applicable) — surface the highlights. Skipped for PASS.
    if (!isPass && r.framework_version === 'v3.2') {
      // Executive summary
      if (r.executive_summary) {
        y = drawQA(doc, y, M, CW, 'EXECUTIVE SUMMARY', r.executive_summary);
      }
      // Final recommendation
      if (r.final_recommendation) {
        y = drawQA(doc, y, M, CW, 'FINAL RECOMMENDATION', r.final_recommendation);
      }
      // Thesis pillars
      if (Array.isArray(r.thesis_pillars) && r.thesis_pillars.length) {
        y = ensureSpace(doc, y, 60);
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
           .text('THESIS PILLARS', M, y);
        y += 14;
        r.thesis_pillars.forEach((p, i) => {
          const pillarText = typeof p === 'string' ? p : (p.description || p.name || JSON.stringify(p));
          y = ensureSpace(doc, y, 40);
          doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
             .text(`${i + 1}.`, M, y, { lineBreak: false });
          doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(10)
             .text(String(pillarText), M + 20, y, { width: CW - 20 });
          y = doc.y + 8;
        });
        y += 4;
      }
      // Expected return summary
      const er = r.expected_return || {};
      if (er && (er.bull || er.base || er.bear)) {
        y = ensureSpace(doc, y, 80);
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
           .text('EXPECTED RETURN (BULL / BASE / BEAR)', M, y);
        y += 14;
        const scenarios = [
          { k: 'BULL', v: er.bull },
          { k: 'BASE', v: er.base },
          { k: 'BEAR', v: er.bear },
        ];
        const sw = (CW - 8) / 3;
        scenarios.forEach((s, i) => {
          const x = M + i * (sw + 4);
          doc.rect(x, y, sw, 50).fill(CREAM);
          doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
             .text(s.k, x + 10, y + 8);
          const val = s.v && typeof s.v === 'object'
            ? (s.v.irr ? `IRR ${s.v.irr}` : s.v.upside ? `${s.v.upside}` : JSON.stringify(s.v).slice(0, 40))
            : (s.v || '—');
          doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
             .text(String(val), x + 10, y + 22, { width: sw - 20, ellipsis: true, lineBreak: false });
        });
        y += 60;
      }
    }

    // Catalysts (legacy pre-v3.2) — skipped for PASS (no thesis to catalyze).
    const cats = Array.isArray(r.catalysts) ? r.catalysts.filter(Boolean) : [];
    if (!isPass && r.framework_version !== 'v3.2' && cats.length) {
      y = ensureSpace(doc, y, 40);
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
         .text('CATALYSTS', M, y);
      y += 14;
      cats.forEach(c => {
        y = ensureSpace(doc, y, 20);
        doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(10)
           .text('• ' + String(c), M, y, { width: CW });
        y = doc.y + 4;
      });
      y += 6;
    }

    // Pre-mortem (legacy pre-v3.2) — skipped for PASS.
    if (!isPass && r.framework_version !== 'v3.2' && r.pre_mortem) {
      y = drawQA(doc, y, M, CW, 'PRE-MORTEM (WHAT WOULD CHANGE MY MIND)', r.pre_mortem);
    }

    // Reviews section — 3m / 6m / 12m. Skipped for PASS: a declined
    // opportunity does not open a position, so recurring reviews do not
    // apply (the ticker stays on the watchlist for scan-based tracking).
    if (!isPass) {
    y = ensureSpace(doc, y, 80);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('SCHEDULED REVIEWS', M, y);
    y += 14;
    const today = new Date().toISOString().slice(0, 10);
    const reviewRows = [
      { lbl: '3-MONTH',  date: r.review_3m_date,  done: r.review_3m_done_at,  outcome: r.review_3m_outcome },
      { lbl: '6-MONTH',  date: r.review_6m_date,  done: r.review_6m_done_at,  outcome: r.review_6m_outcome },
      { lbl: '12-MONTH', date: r.review_12m_date, done: r.review_12m_done_at, outcome: r.review_12m_outcome },
    ];
    reviewRows.forEach(rv => {
      y = ensureSpace(doc, y, 40);
      const state = rv.done ? 'DONE' : (rv.date && rv.date <= today ? 'DUE' : 'SCHEDULED');
      const stateColor = rv.done ? GREEN : (state === 'DUE' ? RED : GRAY_MID);
      doc.rect(M, y, CW, 32).strokeColor(RULE).lineWidth(1).stroke();
      // Left: label
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
         .text(`${rv.lbl}  ·  ${fmtDate(rv.date)}`, M + 10, y + 10, { lineBreak: false, width: CW - 120 });
      // Right: status pill
      doc.font('Helvetica-Bold').fontSize(8);
      const pillW = doc.widthOfString(state) + 16;
      doc.roundedRect(M + CW - pillW - 10, y + 8, pillW, 16, 2).fill(stateColor);
      doc.fillColor('#ffffff').text(state, M + CW - pillW - 2, y + 12, { lineBreak: false, width: pillW - 8 });
      y += 36;
      // Outcome (if written) — flows below the pill
      if (rv.outcome) {
        y = ensureSpace(doc, y, 30);
        const innerW = CW - 20;
        const h = doc.heightOfString(rv.outcome, { width: innerW }) + 12;
        doc.rect(M + 10, y, CW - 20, h).fill(CREAM);
        doc.fillColor(NEAR_BLACK).font('Helvetica-Oblique').fontSize(9)
           .text(String(rv.outcome), M + 20, y + 6, { width: innerW - 20 });
        y += h + 8;
      }
    });
    y += 6;
    } // /!isPass reviews

    // Lesson learned (if any) — relevant for closed positions, not PASS.
    if (!isPass && r.lesson_learned) {
      y = drawQA(doc, y, M, CW, 'LESSON LEARNED', r.lesson_learned);
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fY = doc.page.height - 40;
      doc.rect(0, fY, W, 40).fill(CREAM);
      doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
         .text('CONFIDENTIAL  ·  DCE HOLDINGS  ·  INVESTMENT OFFICE', M, fY + 10, { lineBreak: false });
      doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
         .text(`Page ${i + 1} of ${range.count}`, M, fY + 10, { width: CW, align: 'right', lineBreak: false });
      doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(7)
         .text(`Generated ${new Date().toISOString().slice(0, 10)}  ·  Entry #${r.id}`, M, fY + 22, { width: CW, lineBreak: false, height: 10 });
    }

    doc.end();
    await done;

    const buf = Buffer.concat(chunks);
    const dateCompact = (r.decision_date || '').replace(/-/g, '');
    const filename = `DCE_Decision_${r.ticker}_${r.decision_type}_${dateCompact}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    // inline so the browser opens the PDF in a new tab (like Company Brief,
    // Thesis Builder, etc.), instead of triggering a download / print dialog.
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.status(200).end(buf);
  } catch (e) {
    console.error('[decision-pdf]', e);
    res.setHeader('content-type', 'application/json');
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

// ─── helpers ──────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch { return s; }
}
function fmtPrice(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function drawQA(doc, y, M, CW, label, body) {
  y = ensureSpace(doc, y, 60);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text(label, M, y);
  y += 14;
  const txt = (body && String(body).trim()) || '—';
  const innerW = CW - 16;
  const h = doc.heightOfString(txt, { width: innerW }) + 16;
  y = ensureSpace(doc, y, h + 10);
  doc.rect(M, y, CW, h).strokeColor(RULE).lineWidth(1).stroke();
  doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(10)
     .text(txt, M + 8, y + 8, { width: innerW });
  return y + h + 12;
}
function ensureSpace(doc, y, needed) {
  const bottom = doc.page.height - 60;
  if (y + needed > bottom) {
    doc.addPage();
    return 60;
  }
  return y;
}
