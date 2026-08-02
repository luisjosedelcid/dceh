// Generate a Dashboard HTML from the uploaded Excel + card metadata.
// v1: deterministic template using DCE brandbook (navy/gold/Calibri).
// Reads the "excel" slot from pipeline_card_assets, parses KPIs, renders
// an HTML dashboard, uploads it as the new active "dashboard_html" slot.
//
// POST /api/admin/pipeline-card-generate-dashboard?card_id=<uuid>

const XLSX = require('xlsx');
const { requireRole } = require('../_require-role');
const { sbInsert, sbSelect, sbUpdate } = require('../_supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'pipeline-assets';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmt(v, kind='auto') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (kind === 'pct' || (kind === 'auto' && Math.abs(n) > 0 && Math.abs(n) < 1)) {
      return (n * 100).toFixed(2) + '%';
    }
    if (kind === 'money' || (kind === 'auto' && Math.abs(n) >= 1000)) {
      return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return String(v);
}

// Extract KPIs from a "Columbia" style workbook: (Section, Metric, Value, Notes)
function extractKPIs(wb) {
  const kpis = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (const r of rows) {
      if (!r || r.length < 3) continue;
      const [section, metric, value, notes] = r;
      if (!metric) continue;
      // Skip header row
      if (String(section).toLowerCase() === 'section' && String(metric).toLowerCase() === 'metric') continue;
      if (typeof metric === 'string' && metric.trim() && (value !== '' && value !== null && value !== undefined)) {
        kpis.push({
          section: String(section || '').trim(),
          metric: String(metric).trim(),
          value,
          notes: String(notes || '').trim(),
        });
      }
    }
  }
  return kpis;
}

function pickKPI(kpis, needle) {
  const n = needle.toLowerCase();
  return kpis.find(k => k.metric.toLowerCase().includes(n));
}

function renderDashboard(ticker, cardName, kpis, assets) {
  const price     = pickKPI(kpis, 'stock price') || pickKPI(kpis, 'price');
  const mcap      = pickKPI(kpis, 'market cap');
  const epv       = pickKPI(kpis, 'epv per share') || pickKPI(kpis, 'epv/share') || pickKPI(kpis, 'epv');
  const rv        = pickKPI(kpis, 'repro') || pickKPI(kpis, 'reproduction');
  const wacc      = pickKPI(kpis, 'wacc');
  const irr       = pickKPI(kpis, 'irr') || pickKPI(kpis, 'implied irr');
  const franchise = pickKPI(kpis, 'epv / rv') || pickKPI(kpis, 'franchise');
  const growth    = pickKPI(kpis, 'growth needed') || pickKPI(kpis, 'terminal') || pickKPI(kpis, 'break-even');

  const priceNum = price ? Number(price.value) : null;
  const epvNum   = epv ? Number(epv.value) : null;
  const gapPct = (priceNum && epvNum) ? ((epvNum - priceNum) / priceNum) : null;

  const groups = {};
  for (const k of kpis) {
    if (!groups[k.section]) groups[k.section] = [];
    groups[k.section].push(k);
  }

  const now = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

  const kpiTiles = `
    <div class="kpi">
      <div class="lbl">Stock Price</div>
      <div class="val">${price ? fmt(price.value, 'money') : '—'}</div>
      <div class="sub">as of ${esc(now)}</div>
    </div>
    <div class="kpi">
      <div class="lbl">Market Cap</div>
      <div class="val">${mcap ? fmt(mcap.value) : '—'}</div>
      <div class="sub">${mcap && mcap.notes ? esc(mcap.notes) : '&nbsp;'}</div>
    </div>
    <div class="kpi">
      <div class="lbl">EPV / Share</div>
      <div class="val">${epv ? fmt(epv.value, 'money') : '—'}</div>
      <div class="sub">${gapPct !== null ? (gapPct >= 0 ? '+' : '') + (gapPct * 100).toFixed(1) + '% vs. price' : '&nbsp;'}</div>
    </div>
    <div class="kpi">
      <div class="lbl">Base IRR (5Y)</div>
      <div class="val ${irr && Number(irr.value) >= 0.08 ? 'pos' : ''}">${irr ? fmt(irr.value, 'pct') : '—'}</div>
      <div class="sub">${irr && irr.notes ? esc(irr.notes) : '&nbsp;'}</div>
    </div>
  `;

  const franchiseRows = [
    ['Reproduction Value (RV)', rv ? fmt(rv.value, 'money') : '—', rv?.notes || 'Asset-based floor'],
    ['Earnings Power Value (EPV)', epv ? fmt(epv.value, 'money') : '—', epv?.notes || 'Normalized NOPAT / WACC'],
    ['Franchise Multiple (EPV/RV)', franchise ? fmt(franchise.value) + 'x' : '—', franchise?.notes || 'Durable competitive advantage'],
    ['WACC', wacc ? fmt(wacc.value, 'pct') : '—', wacc?.notes || 'Cost of capital'],
    ['Break-even Terminal Growth', growth ? fmt(growth.value, 'pct') : '—', growth?.notes || 'Growth needed'],
  ].map(r => `<tr><td>${esc(r[0])}</td><td class="num">${r[1]}</td><td>${esc(r[2])}</td></tr>`).join('');

  // Sections table (all KPIs by section)
  let sectionsHTML = '';
  for (const [sec, items] of Object.entries(groups)) {
    if (!sec) continue;
    sectionsHTML += `<h3>${esc(sec)}</h3><table>`;
    sectionsHTML += `<tr><th>Metric</th><th>Value</th><th>Notes</th></tr>`;
    sectionsHTML += items.map(k =>
      `<tr><td>${esc(k.metric)}</td><td class="num">${fmt(k.value)}</td><td>${esc(k.notes)}</td></tr>`
    ).join('');
    sectionsHTML += `</table>`;
  }

  // Deliverables card
  const kindLabels = {
    excel: '📊 Excel model',
    company_brief_pdf: '📄 Company Brief',
    thesis_builder_pdf: '📄 Thesis Builder',
    thesis_breaker_pdf: '📄 Thesis Breaker',
    munger_digital_pdf: '📄 Munger Digital',
  };
  const deliverablesHTML = assets.length
    ? '<ul class="deliv">' + assets
        .filter(a => a.kind !== 'dashboard_html')
        .map(a => `<li>${kindLabels[a.kind] || a.kind} — <span class="fn">${esc(a.filename)}</span></li>`)
        .join('') + '</ul>'
    : '<div class="muted">No source deliverables recorded.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ticker)} — DCE Dashboard</title>
<style>
  :root { --navy:#1B2642; --gold:#B88B47; --cream:#F5F1EB; --white:#fff; --gray:#606060;
          --rule:rgba(27,38,66,0.09); --green:#2a7a56; --red:#9b2335; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Calibri',Helvetica,Arial,sans-serif;background:var(--cream);color:var(--navy);padding:32px;line-height:1.5}
  header{background:var(--navy);color:var(--white);padding:24px 32px;margin:-32px -32px 24px}
  header .tag{font-size:10px;letter-spacing:0.25em;color:var(--gold);text-transform:uppercase}
  header h1{font-size:32px;font-weight:300;letter-spacing:-0.01em;margin-top:6px}
  header h1 span{color:var(--gold);font-weight:600}
  header .sub{font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
  @media (max-width:820px){ .grid{grid-template-columns:repeat(2,1fr)} }
  .kpi{background:var(--white);padding:16px;border:1px solid var(--rule);border-top:3px solid var(--gold)}
  .kpi .lbl{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--gray)}
  .kpi .val{font-size:24px;font-weight:600;margin-top:6px}
  .kpi .sub{font-size:11px;color:var(--gray);margin-top:2px;min-height:14px}
  h2{font-size:18px;font-weight:400;margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--gold)}
  h2 span{font-size:10px;color:var(--gold);letter-spacing:0.25em;text-transform:uppercase;margin-left:12px}
  h3{font-size:14px;font-weight:600;margin:20px 0 8px;color:var(--navy);letter-spacing:0.02em}
  table{width:100%;border-collapse:collapse;background:var(--white);margin-bottom:16px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--rule);font-size:13px}
  th{background:var(--navy);color:var(--white);font-weight:500;font-size:11px;letter-spacing:0.05em;text-transform:uppercase}
  td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
  .pos{color:var(--green);font-weight:500}
  .neg{color:var(--red);font-weight:500}
  .deliv{list-style:none;padding:0;margin:0;background:var(--white);border-left:3px solid var(--gold);padding:12px 16px}
  .deliv li{padding:4px 0;font-size:12px;color:var(--gray)}
  .deliv li .fn{color:var(--navy);font-weight:500}
  .muted{color:var(--gray);font-size:12px;font-style:italic}
  footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--rule);font-size:11px;color:var(--gray);text-align:center}
  .banner{background:var(--gold);color:var(--white);padding:14px 20px;font-size:13px;font-weight:500;letter-spacing:0.05em;margin-bottom:24px}
</style>
</head>
<body>
<header>
  <div class="tag">DCE Holdings · Investment Office</div>
  <h1>${esc(ticker)}<span>${cardName && cardName !== ticker ? ' — ' + esc(cardName) : ''}</span></h1>
  <div class="sub">Columbia Valuation Dashboard · Generated ${esc(now)}</div>
</header>

<div class="grid">${kpiTiles}</div>

<h2>Franchise Value <span>Columbia Framework</span></h2>
<table>
  <tr><th>Metric</th><th>Value</th><th>Comment</th></tr>
  ${franchiseRows}
</table>

<h2>Detail by Section <span>From Excel Model</span></h2>
${sectionsHTML || '<div class="muted">No structured data found in workbook.</div>'}

<h2>Source Deliverables <span>Uploaded Files</span></h2>
${deliverablesHTML}

<footer>
  DCE Holdings — Investment Office · Auto-generated ${esc(now)} · Source: Excel model
</footer>
</body>
</html>`;
}

async function downloadFromStorage(path) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`;
  const r = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Storage download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadToStorage(path, buffer, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Storage upload failed: ${r.status} ${t.slice(0, 300)}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const userEmail = auth.user?.email || 'unknown';

  const cardId = req.query.card_id;
  if (!cardId) return res.status(400).json({ error: 'Missing card_id' });

  try {
    // 1) Load card
    const cardRows = await sbSelect('pipeline_cards', `id=eq.${cardId}&select=*`);
    if (!cardRows.length) return res.status(404).json({ error: 'Card not found' });
    const card = cardRows[0];
    const ticker = card.ticker || card.title || 'UNKNOWN';
    const cardName = card.title || card.ticker || '';

    // 2) Load active assets
    const assets = await sbSelect(
      'pipeline_card_assets',
      `card_id=eq.${cardId}&active=eq.true&select=id,kind,filename,storage_path`
    );
    const excelAsset = assets.find(a => a.kind === 'excel');
    if (!excelAsset) {
      return res.status(400).json({ error: 'Missing Excel model. Upload an Excel file before generating.' });
    }

    // 3) Download Excel from bucket
    const excelBuf = await downloadFromStorage(excelAsset.storage_path);

    // 4) Parse
    const wb = XLSX.read(excelBuf, { type: 'buffer' });
    const kpis = extractKPIs(wb);

    // 5) Render HTML
    const html = renderDashboard(ticker, cardName, kpis, assets);
    const htmlBuf = Buffer.from(html, 'utf-8');

    // 6) Upload as new dashboard_html
    const ts = Date.now();
    const filename = `${ticker}_dashboard_auto_${ts}.html`;
    const storagePath = `${cardId}/dashboard_html/${ts}__${filename}`;
    await uploadToStorage(storagePath, htmlBuf, 'text/html');

    // 7) Deactivate prior dashboard_html rows
    await sbUpdate(
      'pipeline_card_assets',
      `card_id=eq.${cardId}&kind=eq.dashboard_html&active=eq.true`,
      { active: false }
    );

    // 8) Insert new row
    const inserted = await sbInsert('pipeline_card_assets', {
      card_id: cardId,
      ticker,
      kind: 'dashboard_html',
      filename,
      storage_path: storagePath,
      size_bytes: htmlBuf.length,
      mime_type: 'text/html',
      uploaded_by: userEmail,
      active: true,
    });

    return res.status(200).json({
      ok: true,
      generated: true,
      asset: inserted[0] || null,
      kpi_count: kpis.length,
    });
  } catch (e) {
    console.error('generate-dashboard error', e);
    return res.status(500).json({ error: e.message || 'Generation failed' });
  }
};
