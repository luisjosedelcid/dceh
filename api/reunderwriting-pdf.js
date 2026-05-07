// GET /api/reunderwriting-pdf?due_id=<id>[&_tok=<admin>]
//
// Generates a branded PDF (DCE NAVY/GOLD) of a signed re-underwriting,
// suitable for archival in the Data Room or sharing with the committee.
//
// Auth: any authenticated user (read-only). Admin token may be passed via
//   x-admin-token header OR the _tok query string (so a plain <a> link from
//   the cockpit drawer works as a download trigger).
//
// Layout:
//   - Navy header bar with "DCE HOLDINGS · INVESTMENT OFFICE" and "Re-underwriting"
//   - Title: <TICKER> · <DOC_TYPE> · period <date>
//   - Meta grid: Filing / Period end / Filed / Signed
//   - Outcome badge (color-coded)
//   - Reviewer
//   - Q1: Thesis still valid
//   - Q2: Kill criteria concern
//   - Kill criteria snapshot (table)
//   - Action + reason
//   - Justification (only if outcome != intact)
//   - Revision section (if a revision was created)
//   - Footer: confidential

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
const ORANGE = '#7a3a08';

const OUTCOMES = {
  thesis_intact:           { fill: '#e3f4ea', text: '#1e6c3a', label: 'TESIS INTACTA' },
  thresholds_recalibrated: { fill: '#fff3cf', text: '#7c5d10', label: 'THRESHOLDS RECALIBRADOS' },
  thesis_evolved:          { fill: '#fde3cf', text: '#7a3a08', label: 'TESIS EVOLUCIONÓ' },
  thesis_broken:           { fill: '#fbd7dd', text: '#7a1424', label: 'TESIS ROTA' },
};

const ACTION_LABELS = { buy_more: 'Buy more', hold: 'Hold', trim: 'Trim', sell: 'Sell' };

module.exports = async (req, res) => {
  try {
    // Auth: header OR query param (so a plain <a> link from the cockpit drawer works)
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
    // Lookup user is_active (lightweight check)
    const users = await sbSelect(
      'admin_users',
      `select=email,is_active&email=eq.${encodeURIComponent(verified.email)}&is_active=eq.true&limit=1`
    );
    if (!users[0]) {
      res.setHeader('content-type', 'application/json');
      res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized: user not found or inactive' }));
      return;
    }

    const dueId = Number(url.searchParams.get('due_id'));
    if (!dueId) {
      res.setHeader('content-type', 'application/json');
      res.status(400).end(JSON.stringify({ ok: false, error: 'due_id required' }));
      return;
    }

    // Pull due + source + entry + revision (mirrors reunderwriting-detail.js)
    const dues = await sbSelect(
      'reunderwriting_due',
      `select=id,ticker,period_end,doc_type,status,due_at,completed_at,entry_id,notes,outcome,outcome_notes,revision_id,source_documents(source_url,filed_at)&id=eq.${dueId}&limit=1`
    );
    if (dues.length === 0) {
      res.setHeader('content-type', 'application/json');
      res.status(404).end(JSON.stringify({ ok: false, error: 'due not found' }));
      return;
    }
    const d = dues[0];
    const sd = d.source_documents || {};

    let entry = null;
    if (d.entry_id) {
      const rows = await sbSelect('reunderwriting_entries', `select=*&id=eq.${d.entry_id}&limit=1`);
      entry = rows[0] || null;
    }
    let revision = null;
    if (d.revision_id) {
      const rows = await sbSelect('premortem_revisions', `select=*&id=eq.${d.revision_id}&limit=1`);
      revision = rows[0] || null;
    }

    // Build PDF
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 54, right: 54 },
      info: {
        Title: `DCE Holdings — Re-underwriting ${d.ticker} ${d.doc_type} ${d.period_end}`,
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
       .text('Re-underwriting', M, 14, { width: CW, align: 'right' });

    let y = 70;

    // Section label
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('SIGNED RE-UNDERWRITING', M, y, { characterSpacing: 1.5 });
    y += 14;

    // Title
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22)
       .text(`${d.ticker}  ·  ${d.doc_type}  ·  period ${fmtDate(d.period_end)}`, M, y);
    y += 32;

    // Meta grid (4 cells)
    const metaCells = [
      { k: 'FILING', v: d.doc_type || '—' },
      { k: 'PERIOD END', v: fmtDate(d.period_end) },
      { k: 'FILED', v: fmtDate(sd.filed_at) },
      { k: 'SIGNED', v: fmtDateTime(d.completed_at) },
    ];
    const cellW = (CW - 12) / 4;
    metaCells.forEach((c, i) => {
      const x = M + i * (cellW + 4);
      doc.rect(x, y, cellW, 50).fill(CREAM);
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
         .text(c.k, x + 10, y + 8, { characterSpacing: 1.2 });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13)
         .text(c.v || '—', x + 10, y + 22, { width: cellW - 20, ellipsis: true, lineBreak: false });
    });
    y += 60;

    // Source URL (if any)
    if (sd.source_url) {
      doc.fillColor(GOLD).font('Helvetica').fontSize(9)
         .text('View filing on EDGAR', M, y, { link: sd.source_url, underline: true });
      y += 18;
    }

    // Outcome badge
    const oc = OUTCOMES[d.outcome] || null;
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('OUTCOME', M, y, { characterSpacing: 1.2 });
    y += 12;
    if (oc) {
      const w = doc.widthOfString(oc.label) + 24;
      doc.roundedRect(M, y, w, 22, 3).fill(oc.fill);
      doc.fillColor(oc.text).font('Helvetica-Bold').fontSize(10)
         .text(oc.label, M + 12, y + 6, { lineBreak: false, width: w - 24 });
      y += 30;
    } else {
      doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(10)
         .text('— (sin clasificar — pre-versionado)', M, y);
      y += 22;
    }

    // Reviewer
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('REVIEWER', M, y, { characterSpacing: 1.2 });
    y += 12;
    doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(11)
       .text(entry ? (entry.reviewer_email || '—') : '—', M, y);
    y += 22;

    // Q1
    y = drawQA(doc, y, M, CW, '1. THESIS STILL VALID', entry?.thesis_still_valid);
    // Q2
    y = drawQA(doc, y, M, CW, '2. KILL CRITERIA CONCERN', entry?.kill_criteria_concern || '(none reported)');

    // Kill criteria snapshot
    if (entry && Array.isArray(entry.kill_criteria_snapshot) && entry.kill_criteria_snapshot.length) {
      y = ensureSpace(doc, y, 60);
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
         .text('KILL CRITERIA SNAPSHOT (AT TIME OF SIGNING)', M, y, { characterSpacing: 1.2 });
      y += 14;
      // Table header
      doc.rect(M, y, CW, 20).fill(NAVY);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      doc.text('STATUS', M + 8, y + 6, { width: 70, lineBreak: false });
      doc.text('FAILURE MODE', M + 90, y + 6, { width: CW - 90 - 70 - 70, lineBreak: false });
      doc.text('PROB', M + CW - 140, y + 6, { width: 60, lineBreak: false, align: 'right' });
      doc.text('SEVERITY', M + CW - 70, y + 6, { width: 62, lineBreak: false, align: 'right' });
      y += 20;
      entry.kill_criteria_snapshot.forEach((fm, i) => {
        const rowH = 22;
        y = ensureSpace(doc, y, rowH + 2);
        if (i % 2 === 0) doc.rect(M, y, CW, rowH).fill('#f9f7f3');
        const statusColor = fm.status === 'triggered' ? RED : (fm.status === 'resolved' ? GREEN : AMBER);
        doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(8)
           .text((fm.status || '—').toUpperCase(), M + 8, y + 7, { width: 70, lineBreak: false });
        doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(9)
           .text(fm.failure_mode || '—', M + 90, y + 7, { width: CW - 90 - 140, lineBreak: false, ellipsis: true });
        doc.fillColor(GRAY_TXT).font('Helvetica').fontSize(9)
           .text(fm.probability_pct != null ? `P${fm.probability_pct}%` : '—', M + CW - 140, y + 7, { width: 60, align: 'right', lineBreak: false });
        doc.fillColor(GRAY_TXT).font('Helvetica').fontSize(9)
           .text(fm.severity_pct != null ? `S${fm.severity_pct}%` : '—', M + CW - 70, y + 7, { width: 62, align: 'right', lineBreak: false });
        y += rowH;
      });
      y += 8;
    }

    // Action
    y = ensureSpace(doc, y, 60);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
       .text('ACTION', M, y, { characterSpacing: 1.2 });
    y += 12;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
       .text(entry ? (ACTION_LABELS[entry.action] || entry.action) : '—', M, y);
    y += 20;
    if (entry && entry.action_reason) {
      doc.fillColor(GRAY_TXT).font('Helvetica-Oblique').fontSize(10)
         .text(entry.action_reason, M, y, { width: CW });
      y = doc.y + 8;
    }

    // Justification (only if outcome != intact)
    if (d.outcome_notes) {
      y = ensureSpace(doc, y, 60);
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
         .text('JUSTIFICATION FOR CHANGE', M, y, { characterSpacing: 1.2 });
      y += 14;
      const innerW = CW - 16;
      doc.save();
      const txt = d.outcome_notes;
      const h = doc.heightOfString(txt, { width: innerW }) + 16;
      doc.rect(M, y, CW, h).fill('#fff8ec');
      doc.rect(M, y, 3, h).fill(GOLD);
      doc.restore();
      doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(10)
         .text(txt, M + 12, y + 8, { width: innerW });
      y = y + h + 10;
    }

    // Revision section
    if (revision) {
      y = ensureSpace(doc, y, 80);
      doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(RULE).lineWidth(1).stroke();
      y += 10;
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
         .text(`REVISION CREATED  ·  V${revision.version_num}`, M, y, { characterSpacing: 1.2 });
      y += 14;

      const revCells = [
        { k: 'VERSION', v: `V${revision.version_num}` },
        { k: 'TYPE', v: revision.change_type || '—' },
        { k: 'COMMITTEE', v: revision.ratified_by_committee ? 'Ratified' : 'Pending' },
      ];
      const rcW = (CW - 8) / 3;
      revCells.forEach((c, i) => {
        const x = M + i * (rcW + 4);
        doc.rect(x, y, rcW, 38).fill(CREAM);
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(7)
           .text(c.k, x + 10, y + 6, { characterSpacing: 1.2 });
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
           .text(c.v, x + 10, y + 18, { width: rcW - 20, lineBreak: false, ellipsis: true });
      });
      y += 48;

      if (revision.thesis_summary) {
        y = ensureSpace(doc, y, 60);
        doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
           .text(`THESIS (SNAPSHOT V${revision.version_num})`, M, y, { characterSpacing: 1.2 });
        y += 14;
        doc.fillColor(NEAR_BLACK).font('Helvetica').fontSize(10)
           .text(revision.thesis_summary, M, y, { width: CW });
        y = doc.y + 8;
      }
    }

    // Footer (last page)
    const footerY = doc.page.height - 50;
    doc.moveTo(M, footerY).lineTo(M + CW, footerY).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.fillColor(GRAY_MID).font('Helvetica').fontSize(7)
       .text(`Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z  ·  Due #${d.id}  ·  Entry #${d.entry_id || '—'}  ·  Revision #${d.revision_id || '—'}`, M, footerY + 8, { width: CW });
    doc.fillColor(GRAY_MID).font('Helvetica-Oblique').fontSize(7)
       .text('DCE Holdings Investment Office — Confidential · Internal use only', M, footerY + 22, { width: CW });

    doc.end();
    await done;

    const buf = Buffer.concat(chunks);
    const filename = `DCE_ReUnderwriting_${d.ticker}_${d.doc_type}_${d.period_end}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.status(200).end(buf);
  } catch (e) {
    console.error('[reunderwriting-pdf]', e);
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
function fmtDateTime(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  } catch { return s; }
}
function drawQA(doc, y, M, CW, label, body) {
  y = ensureSpace(doc, y, 60);
  const NAVY = '#1B2642', GOLD = '#B88B47', RULE = '#e8e6e0', NEAR_BLACK = '#0d0d0d', GRAY_MID = '#8a9098';
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(8)
     .text(label, M, y, { characterSpacing: 1.2 });
  y += 14;
  const txt = (body && String(body).trim()) || '—';
  const innerW = CW - 16;
  const h = doc.heightOfString(txt, { width: innerW }) + 16;
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
