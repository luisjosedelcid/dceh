/* ============================================================
   company.js — DCE Holdings Columbia Dashboard
   Universal data-driven companion for company.html
   All calc logic, Chart.js charts, sliders, and renderers
   ============================================================ */

'use strict';

/* ── globals ─────────────────────────────────────────────── */
let D = null;          // loaded JSON data object
let charts = {};       // Chart instances keyed by canvas id
let currentPrice = 0;  // editable market price
let reviewDate = '';

/* ── helpers ─────────────────────────────────────────────── */
function sym()   { return D.currencySymbol || '$'; }
function M(v, d) { return v != null ? `${sym()}${fmt(v)}M` : (d !== undefined ? d : '—'); }
function B(v)    { return v != null ? `${sym()}${fmtB(v)}` : '—'; }
function Pct(v)  { return v != null ? `${v.toFixed(1)}%` : '—'; }
function Mul(v)  { return v != null ? `${v.toFixed(1)}×` : '—'; }
function fmt(n)  { return n == null ? '—' : Number(n).toLocaleString('en-US', {maximumFractionDigits: 0}); }
function fmtB(n) { // n in millions → format as B/M
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return `${(n/1000).toFixed(1)}B`;
  return `${fmt(n)}M`;
}
function fmtDec(n, d) { return n == null ? '—' : Number(n).toLocaleString('en-US', {minimumFractionDigits: d||0, maximumFractionDigits: d||0}); }
function fmtPrice(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${sym()}${fmt(Math.round(n))}`;
  return `${sym()}${fmtDec(n, 2)}`;
}
function colored(v, threshold, invertBetter) {
  // invertBetter=true means lower=better (e.g. debt ratios)
  const good = invertBetter ? v <= threshold : v >= threshold;
  return good ? 'green' : 'red';
}
function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function setTxt(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

/* ── init ─────────────────────────────────────────────────── */
async function initDashboard() {
  // Resolve ticker from (1) ?ticker=XXX query param, (2) URL path /xxx, (3) default BKNG
  // Vercel rewrites strip the destination query string from location.search,
  // so we also parse window.location.pathname (e.g. '/sap' -> 'SAP').
  const params = new URLSearchParams(window.location.search);
  let ticker = params.get('ticker');
  if (!ticker) {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    // path could be 'sap', 'bkng', 'company.html', etc.
    if (path && path !== 'company.html' && path !== 'company' && !path.includes('/')) {
      ticker = path;
    }
  }
  ticker = (ticker || 'BKNG').toUpperCase();
  const period = params.get('period');
  window.__currentTicker = ticker;
  window.__currentPeriod = period;

  try {
    // Try the versioned API first; fall back to legacy static JSON.
    let apiUrl = `/api/dashboard?ticker=${encodeURIComponent(ticker)}`;
    if (period) apiUrl += `&period=${encodeURIComponent(period)}`;
    let res = await fetch(apiUrl);
    if (!res.ok) {
      // Legacy fallback for tickers not yet migrated to Supabase
      res = await fetch(`/companies/${ticker.toLowerCase()}.json`);
      if (!res.ok) throw new Error(`No data file for ${ticker}`);
    }
    D = await res.json();
    window.D = D;  // expose to inline scripts in company.html
    window.fmt = fmt; // expose helpers used by inline slider handlers
  } catch(e) {
    document.body.innerHTML = `<div style="padding:60px;font-family:sans-serif;color:#9b2335">
      <h2>Error loading ${ticker}</h2><p>${e.message}</p>
      <p><a href="/">← Back to Universe</a></p>
    </div>`;
    return;
  }

  currentPrice = D.overview.stockPrice;
  reviewDate = D.valuationDate;

  buildMeta();
  buildHeader();
  buildNav();
  // Async — don't block initial render
  buildVersionControls(ticker).catch(err => console.warn('version controls failed:', err));
  switchTab('overview');
}

/* ── version controls (selector + banner) ─────────────────── */
async function buildVersionControls(ticker) {
  const banner = document.getElementById('version-banner');
  const selector = document.getElementById('version-selector');
  if (!banner && !selector) return; // page didn't include the controls

  let versions = [];
  try {
    const r = await fetch(`/api/list-dashboard-versions?ticker=${encodeURIComponent(ticker)}`);
    if (r.ok) {
      const j = await r.json();
      versions = Array.isArray(j.versions) ? j.versions : [];
    }
  } catch (_) { /* ignore */ }

  // Populate selector (lives inside the nav row)
  if (selector) {
    if (versions.length < 2) {
      // Hide selector entirely when there's only 1 version (no choice to make)
      selector.style.display = 'none';
    } else {
      selector.style.display = 'inline-flex';
      const current = (D && D.__version && D.__version.fiscal_period) || null;
      const opts = versions.map(v => {
        const sel = (current && v.fiscal_period === current) ? ' selected' : '';
        const tag = v.is_latest ? ' (latest)' : '';
        return `<option value="${v.fiscal_period}"${sel}>${v.fiscal_period}${tag}</option>`;
      }).join('');
      selector.innerHTML = `<span style="font-size:10px;color:var(--gray-mid);text-transform:uppercase;letter-spacing:0.12em;font-weight:600">Versión</span>
        <select id="version-select" onchange="onVersionChange(this.value)"
          style="background:#fff;border:1px solid var(--line);color:var(--navy);font-family:Archivo,sans-serif;font-size:12px;font-weight:600;padding:5px 10px;border-radius:4px;outline:none;cursor:pointer">
          ${opts}
        </select>`;
    }
  }

  // Banner if viewing a non-latest version
  if (banner) {
    const v = D && D.__version;
    const showBanner = v && v.is_latest === false;
    if (showBanner) {
      const latest = versions.find(x => x.is_latest);
      const latestPeriod = latest ? latest.fiscal_period : 'la más reciente';
      const latestUrl = `?ticker=${encodeURIComponent(ticker)}` + (latest ? `&period=${encodeURIComponent(latest.fiscal_period)}` : '');
      banner.style.display = '';
      banner.innerHTML = `
        <strong>Versión histórica:</strong> Estás viendo <code style="background:rgba(0,0,0,0.08);padding:1px 6px;border-radius:3px">${v.fiscal_period}</code>.
        La versión actual es <a href="/${ticker.toLowerCase()}" style="color:#5b3c0f;text-decoration:underline;font-weight:600">${latestPeriod}</a>.`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function onVersionChange(period) {
  const t = window.__currentTicker;
  if (!t) return;
  const url = new URL(window.location.href);
  url.searchParams.set('ticker', t);
  if (period) url.searchParams.set('period', period);
  else url.searchParams.delete('period');
  window.location.href = url.toString();
}
window.onVersionChange = onVersionChange;

/* ── meta ─────────────────────────────────────────────────── */
function buildMeta() {
  document.title = `DCE Holdings — ${D.name} (${D.ticker}) | Columbia Model`;
}

/* ── header ─────────────────────────────────────────────────── */
function buildHeader() {
  setEl('hdr-company', `${D.name} (${D.ticker}) &nbsp;·&nbsp; ${D.exchange} &nbsp;·&nbsp; ${D.fiscalYear}`);
  document.getElementById('price-input').value = fmtDec(currentPrice, currentPrice >= 100 ? 0 : 2);
  updateHeaderKPIs();
  setEl('last-review-display', reviewDate);
}

function updateHeaderKPIs() {
  const irr = D.irr.impliedIrr;
  const mos = D.irr.mos;
  const epvPs = D.epv.epvPerShare;
  const irrColor = irr >= D.irr.hurdle ? 'var(--green)' : 'var(--red)';
  const mosColor = mos >= 0 ? 'var(--green)' : 'var(--red)';
  const mosSign  = mos >= 0 ? '+' : '';
  setEl('hdr-irr',   `<span style="color:${irrColor}">${Pct(irr)}</span>`);
  setEl('hdr-epv-ps', `${sym()}${fmtDec(epvPs, epvPs >= 100 ? 0 : 2)}`);
  setEl('hdr-mos',   `<span style="color:${mosColor}">${mosSign}${Pct(mos)}</span>`);
  // price/EPV ratio
  const ratio = currentPrice / epvPs;
  const ratioColor = ratio <= 1 ? 'var(--green)' : ratio <= 1.5 ? 'var(--gold)' : 'var(--red)';
  setEl('hdr-price-epv', `<span style="color:${ratioColor}">${fmtDec(ratio,2)}×</span>`);
}

function onPriceInput(val) {
  const n = parseFloat(val.replace(/[,\s]/g,''));
  if (!isNaN(n) && n > 0) {
    currentPrice = n;
    updateHeaderKPIs();
    // re-render active tab outputs that use price
    refreshPriceDependents();
  }
}

function refreshPriceDependents() {
  // re-render summary/IRR elements that depend on price
  const el = document.querySelector('#tab-irr');
  if (el && el.classList.contains('active')) renderIrr();
  const elSummary = document.querySelector('#tab-summary');
  if (elSummary && elSummary.classList.contains('active')) renderSummary();
}

/* ── nav ─────────────────────────────────────────────────── */
function buildNav() {
  const nav = document.getElementById('main-nav');
  const tabs = [
    {id:'version',     label:'',  versionSlot: true},
    {id:'overview',    label:'Overview'},
    {id:'financials',  label:'Financials'},
    {id:'adj',         label:'Adjustments'},
    {id:'rv',          label:'Reprod. Value'},
    {id:'epv',         label:'EPV'},
    {id:'roic',        label:'ROIC & Capital'},
    {id:'irr',         label:'Implied IRR'},
    {id:'health',      label:'Health Check'},
    {id:'audit',       label:'CIO Decisions'},
    {id:'vr',          label:'Valuation Report', external: D.documents.valuationReportUrl, style:'font-weight:600'},
    {id:'tb',          label:'Thesis Breaker',    external: D.documents.thesisBreakerUrl,  style:'color:var(--red);font-weight:600'},
    {id:'munger',      label:'Munger Digital',    external: D.documents.mungerDigitalUrl,  style:'color:#6b4fa0;font-weight:600'},
    {id:'summary',     label:'Summary'},
    {id:'home',        label:'← Home', home: true, style:'margin-left:auto;color:var(--gray-mid)'},
  ];

  nav.innerHTML = tabs.map(t => {
    if (t.versionSlot) {
      return `<div id="version-selector" style="display:none;align-items:center;gap:8px;padding:0 14px 0 0;margin-right:8px;border-right:1px solid var(--line)"></div>`;
    }
    if (t.external) {
      if (t.external) {
        return `<button onclick="window.open('${t.external}','_blank')" style="${t.style||''}">${t.label}</button>`;
      }
    }
    if (t.home) {
      return `<button onclick="window.location.href='/'" style="${t.style||''}">${t.label}</button>`;
    }
    return `<button id="nav-${t.id}" onclick="switchTab('${t.id}',this)" style="${t.style||''}">${t.label}</button>`;
  }).join('');

  // handle missing document links
  rebuildDocButtons();
}

function rebuildDocButtons() {
  // called after nav build to fix null doc URLs
  const docs = D.documents;
  ['vr','tb','munger'].forEach(id => {
    const btn = document.querySelector(`#main-nav button[onclick*="nav-${id}"]`);
    // already handled in buildNav — nothing needed
  });
}

function switchTab(id, btnEl) {
  // hide all
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#main-nav button').forEach(b => b.classList.remove('active'));
  // show target
  const tab = document.getElementById(`tab-${id}`);
  if (tab) tab.classList.add('active');
  // activate button
  const btn = btnEl || document.getElementById(`nav-${id}`);
  if (btn) btn.classList.add('active');
  // lazy-render
  renderTab(id);
}

/* ── tab router ─────────────────────────────────────────────── */
function renderTab(id) {
  switch(id) {
    case 'overview':   renderOverview(); break;
    case 'financials': renderFinancials(); break;
    case 'adj':        renderAdj(); break;
    case 'rv':         renderRV(); break;
    case 'epv':        renderEPV(); break;
    case 'roic':       renderROIC(); break;
    case 'irr':        renderIrr(); break;
    case 'health':     renderHealth(); break;
    case 'audit':      renderAudit(); break;
    case 'summary':    renderSummary(); break;
  }
}

/* ════════════════════════════════════════════════════════════
   1. OVERVIEW
   ════════════════════════════════════════════════════════════ */
function renderOverview() {
  const ov = D.overview;
  const sym_ = sym();

  // KPI cards
  setEl('ov-mktcap', B(ov.marketCap));
  setEl('ov-mktcap-sub', `${fmt(ov.shares)}${ov.shares < 100 ? 'M' : 'M'} diluted shares`);
  setEl('ov-ev', B(ov.ev));
  setEl('ov-nopat', M(ov.nopatNorm));
  setEl('ov-nopat-sub', `Rev ${B(ov.revenue)} × ${Pct(ov.operMargin*100)} norm. margin × (1−${Pct(ov.taxRate*100)})`);
  setEl('ov-fcf', M(ov.fcfLatest));
  setEl('ov-fcf-sub', `FCF Margin ${Pct(ov.fcfMargin*100)}`);

  // metrics
  const irrColor = D.irr.impliedIrr >= D.irr.hurdle ? 'green' : 'red';
  const mosSign  = D.irr.mos >= 0 ? '+' : '';
  const mosCls   = D.irr.mos >= 0 ? 'bg' : 'br';
  setEl('ov-irr', `<span class="cval ${irrColor}">${Pct(D.irr.impliedIrr)}</span>`);
  setEl('ov-mos', `<span class="badge ${mosCls}">MoS ${mosSign}${Pct(D.irr.mos)}</span>`);
  setEl('ov-hurdle-sub', `Hurdle ${Pct(D.irr.hurdle)}`);
  setEl('ov-roic3yr', Pct(ov.roic3yr * (ov.roic3yr > 2 ? 1 : 100)));
  const spreadRaw = (ov.roic3yr > 2 ? ov.roic3yr*100 : ov.roic3yr) - ov.wacc*100;
  setEl('ov-roic-sub', `vs. WACC ${Pct(ov.wacc*100)} · Spread +${Pct(spreadRaw)}`);
  setEl('ov-wacc', Pct(ov.wacc*100));
  setEl('ov-wacc-sub', `β ${D.wacc.beta} · Ke ${Pct(D.wacc.ke*100)} · ERP ${Pct(D.wacc.erp*100)}`);

  // model inputs
  const adj = D.adj;
  const irr = D.irr;
  const cio  = D.cioDecisions;
  function cioVal(id) { const r = cio.find(c=>c.id===id); return r ? r.value : '—'; }
  const smRow   = cio.find(c=>c.id==='DP2');
  const rdStatus = smRow ? smRow.value : '—';

  setEl('ov-inputs-nopat',    M(D.epv.nopatBase));
  setEl('ov-inputs-revenue',  M(ov.revenue));
  setEl('ov-inputs-margin',   Pct(ov.operMargin*100));
  setEl('ov-inputs-tax',      Pct(ov.taxRate*100));
  setEl('ov-inputs-wacc',     Pct(ov.wacc*100));
  setEl('ov-inputs-shares',   fmt(ov.shares));
  setEl('ov-irr-roic',   Pct(irr.selectedRoic));
  setEl('ov-irr-organic', Pct(irr.organicGrowth));
  setEl('ov-irr-reinvg',  Pct(irr.reinvGrowth));
  setEl('ov-irr-exit',    `${irr.exitMultiple}× EV/NOPAT`);
  setEl('ov-irr-buybacks', M(irr.buybacks));
  setEl('ov-irr-horizon', `${irr.horizon} years`);
  setEl('ov-cap-sm',    cioVal('DP3') + (adj.smLife ? ` (${adj.smLife}yr)` : ''));
  setEl('ov-cap-rd',    cioVal('DP2'));
  setEl('ov-cap-sbc',   cioVal('DP5'));
  setEl('ov-cap-window',cioVal('DP6'));
  setEl('ov-cap-norm',  cioVal('DP7'));
  setEl('ov-cap-gw',    cioVal('DP12'));

  // charts
  renderOverviewCharts();
}

function renderOverviewCharts() {
  const fin = D.financials;
  const years = fin.years;

  // c1: Revenue & NOPAT
  destroyChart('c1');
  const ctx1 = document.getElementById('c1');
  if (ctx1) {
    charts['c1'] = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: years,
        datasets: [
          { label: 'Revenue', data: fin.revenue, backgroundColor: 'rgba(27,38,66,0.75)', yAxisID: 'y' },
          { label: 'NOPAT (DCE)', data: fin.nopatAdjusted, backgroundColor: 'rgba(184,139,71,0.8)', yAxisID: 'y' },
        ]
      },
      options: chartOpts(`${sym()}M`, `Revenue & NOPAT — ${D.fiscalYear} (${sym()}M)`)
    });
  }

  // c2: Operating & Net Margins
  destroyChart('c2');
  const ctx2 = document.getElementById('c2');
  if (ctx2) {
    charts['c2'] = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          { label: 'Op Margin %', data: fin.operMarginPct, borderColor: '#1b2642', backgroundColor: 'rgba(27,38,66,0.08)', tension: 0.3, fill: true },
          { label: 'Net Margin %', data: fin.netMarginPct,  borderColor: '#b88b47', backgroundColor: 'rgba(184,139,71,0.08)', tension: 0.3, fill: true },
        ]
      },
      options: chartOpts('%', 'Operating & Net Margins (%)')
    });
  }

  // c3: CFO vs FCF vs Buybacks
  destroyChart('c3');
  const ctx3 = document.getElementById('c3');
  if (ctx3) {
    charts['c3'] = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: years,
        datasets: [
          { label: 'CFO',      data: fin.cfo,      backgroundColor: 'rgba(27,38,66,0.7)' },
          { label: 'FCF',      data: fin.fcf,      backgroundColor: 'rgba(42,122,86,0.75)' },
          { label: 'Buybacks', data: fin.buybacks, backgroundColor: 'rgba(184,139,71,0.7)' },
        ]
      },
      options: chartOpts(`${sym()}M`, `CFO vs FCF vs Buybacks (${sym()}M)`)
    });
  }

  // c4: Capital Deployment donut (FY latest)
  destroyChart('c4');
  const ctx4 = document.getElementById('c4');
  if (ctx4) {
    const bk  = fin.buybacks[fin.buybacks.length-1] || 0;
    const div = fin.dividends[fin.dividends.length-1] || 0;
    const fcf = fin.fcf[fin.fcf.length-1] || 0;
    const ret = Math.max(0, fcf - bk - div);
    charts['c4'] = new Chart(ctx4, {
      type: 'doughnut',
      data: {
        labels: ['Buybacks', 'Dividends', 'Retained/Debt'],
        datasets: [{ data: [bk, div, ret],
          backgroundColor: ['#b88b47', '#2a7a56', '#1b2642'],
          borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { font: {size:11}, color:'#606060' } } }
      }
    });
  }
}

/* ════════════════════════════════════════════════════════════
   2. FINANCIALS
   ════════════════════════════════════════════════════════════ */
function renderFinancials() {
  const fin = D.financials;
  renderTable('tbl-is', fin.isRows, fin.years, fin);
  renderTable('tbl-bs', fin.bsRows, fin.years, fin);
  renderTable('tbl-cf', fin.cfRows, fin.years, fin);
  renderFinCharts();
}

function renderTable(containerId, rows, years, fin) {
  const el = document.getElementById(containerId);
  if (!el || !rows) return;
  let html = `<table class="fin-tbl"><thead><tr><th>Item</th>${years.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach(r => {
    if (r.t === 'spacer') { html += `<tr class="spacer-row"><td colspan="${years.length+1}"></td></tr>`; return; }
    if (r.t === 'section') { html += `<tr class="sec-row"><td colspan="${years.length+1}">${r.l}</td></tr>`; return; }
    const cls = r.t === 'total' ? 'tot-row' : r.t === 'subtotal' ? 'sub-row' : r.t === 'margin' ? 'mrg-row' : 'norm-row';
    html += `<tr class="${cls}"><td class="row-lbl">${r.l}</td>`;
    (r.v || Array(years.length).fill(null)).forEach(v => {
      if (v == null) { html += `<td class="num-cell dim">—</td>`; return; }
      let disp;
      if (r.t === 'margin') {
        disp = `${v >= 0 ? '' : ''}${fmtDec(v,1)}%`;
      } else {
        disp = v < 0 ? `(${fmt(Math.abs(v))})` : fmt(v);
      }
      const neg = (r.neg && v > 0) || v < 0;
      const color = r.t === 'margin' ? '' : '';
      html += `<td class="num-cell ${r.t==='total'||r.t==='subtotal'?'fw':''}${neg&&r.t!=='margin'?' dim':''}">${disp}</td>`;
    });
    html += `</tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderFinCharts() {
  const fin = D.financials;
  const years = fin.years;

  destroyChart('c-rev'); destroyChart('c-nopat'); destroyChart('c-margins'); destroyChart('c-cfo');
  const c1 = document.getElementById('c-rev');
  if (c1) charts['c-rev'] = new Chart(c1, {
    type:'bar', data:{ labels:years,
      datasets:[
        {label:'Revenue', data:fin.revenue, backgroundColor:'rgba(27,38,66,0.75)'},
        {label:'Op Income', data:fin.operIncome, backgroundColor:'rgba(184,139,71,0.8)'},
      ]},
    options: chartOpts(`${sym()}M`, `Revenue & Op Income (${sym()}M)`)
  });

  const c2 = document.getElementById('c-nopat');
  if (c2) charts['c-nopat'] = new Chart(c2, {
    type:'bar', data:{ labels:years,
      datasets:[
        {label:'Net Income', data:fin.netIncome, backgroundColor:'rgba(27,38,66,0.7)'},
        {label:'FCF',        data:fin.fcf,       backgroundColor:'rgba(42,122,86,0.75)'},
        {label:'NOPAT (DCE)',data:fin.nopatAdjusted, backgroundColor:'rgba(184,139,71,0.8)'},
      ]},
    options: chartOpts(`${sym()}M`, `Net Income / FCF / NOPAT (${sym()}M)`)
  });

  const c3 = document.getElementById('c-margins');
  if (c3) charts['c-margins'] = new Chart(c3, {
    type:'line', data:{ labels:years,
      datasets:[
        {label:'Op Margin %', data:fin.operMarginPct, borderColor:'#1b2642', backgroundColor:'rgba(27,38,66,0.08)', tension:0.3, fill:true},
        {label:'Net Margin %', data:fin.netMarginPct, borderColor:'#b88b47', backgroundColor:'rgba(184,139,71,0.08)', tension:0.3, fill:true},
      ]},
    options: chartOpts('%', 'Operating & Net Margins (%)')
  });

  const c4 = document.getElementById('c-cfo');
  if (c4) charts['c-cfo'] = new Chart(c4, {
    type:'bar', data:{ labels:years,
      datasets:[
        {label:'CFO', data:fin.cfo, backgroundColor:'rgba(27,38,66,0.7)'},
        {label:'FCF', data:fin.fcf, backgroundColor:'rgba(42,122,86,0.75)'},
        {label:'CapEx', data:fin.fcf.map((f,i)=>fin.cfo[i]-f), backgroundColor:'rgba(155,35,53,0.5)', stack:'stack1'},
      ]},
    options: chartOpts(`${sym()}M`, `CFO / FCF / CapEx (${sym()}M)`)
  });
}

/* ════════════════════════════════════════════════════════════
   3. ADJUSTMENTS
   ════════════════════════════════════════════════════════════ */
function renderAdj() {
  const adj = D.adj;
  const fin = D.financials;
  const years = D.financials.years;

  setEl('adj-gaap-oi',   M(adj.gaapOI));
  setEl('adj-sm-total',  M(adj.mktTotal));
  setEl('adj-sm-avg',    adj.mkt3yrAvg != null ? M(adj.mkt3yrAvg) : '—');
  setEl('adj-sm-life',   adj.smLife != null ? `${adj.smLife} years` : '—');
  setEl('adj-sm-growth', adj.smGrowthExp != null ? M(adj.smGrowthExp) : '—');
  setEl('adj-sm-asset',  adj.smAsset != null ? M(adj.smAsset) : '—');
  setEl('adj-rd-status', adj.rdAsset != null ? `YES — ${M(adj.rdAsset)} capitalized` : 'N/A');
  setEl('adj-rd-life',   adj.rdLife != null ? `${adj.rdLife} years` : 'N/A');
  setEl('adj-rd-growth', adj.rdGrowthExp != null ? M(adj.rdGrowthExp) : 'N/A');
  setEl('adj-nr-total',  adj.nrTotal != null ? M(adj.nrTotal) : '—');
  setEl('adj-nopat-final', M(adj.nopatFinal));
  setEl('adj-tax-rate',  Pct(adj.taxRate));

  // ETR chart
  destroyChart('c-etr');
  const etrCtx = document.getElementById('c-etr');
  if (etrCtx && adj.etrHistory) {
    charts['c-etr'] = new Chart(etrCtx, {
      type:'line', data:{ labels:years,
        datasets:[{ label:'ETR %', data:adj.etrHistory, borderColor:'#b88b47', backgroundColor:'rgba(184,139,71,0.1)', tension:0.3, fill:true }]
      },
      options: chartOpts('%','Effective Tax Rate History (%)')
    });
  }

  // NOPAT build-up table
  const nopatEl = document.getElementById('adj-nopat-table');
  if (nopatEl) {
    let html = `<table class="fin-tbl"><thead><tr><th>Step</th>${years.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
    const smAdj = fin.isRows ? fin.isRows.find(r=>r.l.includes('S&M Growth')) : null;
    const rdAdj = fin.isRows ? fin.isRows.find(r=>r.l.includes('R&D Growth')) : null;
    const nrAdj = fin.isRows ? fin.isRows.find(r=>r.l.includes('Normalization')) : null;
    // Build NOPAT history from nopatAdjusted
    const rows = [
      { l: 'Reported GAAP Operating Income', v: fin.operIncome },
      smAdj ? { l: '(±) S&M Growth Expense Adj', v: smAdj.v } : null,
      rdAdj ? { l: '(+) R&D Growth Expense Adj', v: rdAdj.v } : null,
      nrAdj ? { l: '(+) Non-Recurring Normalization', v: nrAdj.v } : null,
      { l: `× (1 − Tax ${Pct(adj.taxRate)})`, v: fin.nopatAdjusted.map((n,i)=>{ const oi = fin.operIncome[i]; return oi!=null ? Math.round(oi*(1-adj.taxRate/100)) : null; }), dim:true },
      { l: 'Adjusted NOPAT (DCE)', v: fin.nopatAdjusted, bold:true },
    ].filter(Boolean);
    rows.forEach(r => {
      html += `<tr class="${r.bold?'tot-row':'norm-row'}"><td class="row-lbl">${r.l}</td>`;
      (r.v||[]).forEach(v=>{ html += `<td class="num-cell ${r.dim?'dim':''}">${v==null?'—':fmt(v)}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    nopatEl.innerHTML = html;
  }
}

/* ════════════════════════════════════════════════════════════
   4. REPRODUCTION VALUE
   ════════════════════════════════════════════════════════════ */
function renderRV() {
  buildRVTable('rv-tangible',    D.rv.tangibleAssets);
  buildRVTable('rv-intangible',  D.rv.intangibleAssets);
  buildRVTable('rv-other',       D.rv.otherAssets);
  buildRVLiabilities();
  updateRVTotals();
  setEl('rv-note', D.rv.note || '');
}

function buildRVTable(containerId, assets) {
  const el = document.getElementById(containerId);
  if (!el || !assets) return;
  let html = `<table class="fin-tbl rv-tbl">
    <thead><tr><th>Asset</th><th>Book Value</th><th>Adj %</th><th>Repro Value</th><th>Method</th></tr></thead><tbody>`;
  assets.forEach((a, i) => {
    const adj = a.defaultAdj;
    const repro = a.bookValue != null ? Math.round(a.bookValue * adj / 100) : (adj || 0);
    html += `<tr data-rv-cat="${containerId}" data-rv-idx="${i}">
      <td class="row-lbl">${a.label}${a.estimated ? ' <span class="badge bo">EST</span>' : ''}</td>
      <td class="num-cell">${a.bookValue != null ? `${sym()}${fmt(a.bookValue)}M` : 'N/A'}</td>
      <td class="num-cell">
        <input type="number" min="0" max="200" value="${adj}"
          style="width:58px;border:1px solid #e6e6e6;padding:2px 4px;font-family:inherit;font-size:12px;text-align:right;background:#faf8f4"
          onchange="onRVAdj(this,'${containerId}',${i})"
        />%
      </td>
      <td class="num-cell fw" id="rv-val-${containerId}-${i}">${sym()}${fmt(repro)}M</td>
      <td class="num-cell dim" style="font-size:11px">${a.method}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function buildRVLiabilities() {
  const el = document.getElementById('rv-liabilities');
  if (!el || !D.rv.liabilities) return;
  let html = `<table class="fin-tbl">
    <thead><tr><th>Liability</th><th>Value</th><th>Method</th></tr></thead><tbody>`;
  D.rv.liabilities.forEach(l => {
    html += `<tr><td class="row-lbl">${l.label}</td><td class="num-cell">(${sym()}${fmt(l.value)}M)</td><td class="num-cell dim" style="font-size:11px">${l.method}</td></tr>`;
  });
  html += `<tr class="tot-row"><td class="row-lbl">Total Liabilities</td><td class="num-cell">(${sym()}${fmt(D.rv.totalLiabilities)}M)</td><td></td></tr>`;
  html += '</tbody></table>';
  el.innerHTML = html;
}

function onRVAdj(inputEl, cat, idx) {
  const newAdj = parseFloat(inputEl.value) || 0;
  let assetArr;
  if (cat === 'rv-tangible')   assetArr = D.rv.tangibleAssets;
  if (cat === 'rv-intangible') assetArr = D.rv.intangibleAssets;
  if (cat === 'rv-other')      assetArr = D.rv.otherAssets;
  if (!assetArr) return;
  assetArr[idx].defaultAdj = newAdj;
  // recalc this cell
  const asset = assetArr[idx];
  const newRepro = asset.bookValue != null ? Math.round(asset.bookValue * newAdj / 100) : (newAdj || 0);
  setEl(`rv-val-${cat}-${idx}`, `${sym()}${fmt(newRepro)}M`);
  updateRVTotals();
}

function updateRVTotals() {
  function sumCat(arr) {
    return (arr||[]).reduce((s,a,i) => {
      const bv = a.bookValue;
      const adj = a.defaultAdj;
      const repro = bv != null ? Math.round(bv * adj / 100) : (adj || 0);
      return s + repro;
    }, 0);
  }
  const tang = sumCat(D.rv.tangibleAssets);
  const intan = sumCat(D.rv.intangibleAssets);
  const other = sumCat(D.rv.otherAssets);
  const total = tang + intan + other;
  const liab  = D.rv.totalLiabilities;
  const equity = total - liab;
  const perShare = D.overview.shares > 0 ? equity / D.overview.shares : 0;

  setEl('rv-total-tang',  M(tang));
  setEl('rv-total-intan', M(intan));
  setEl('rv-total-other', M(other));
  setEl('rv-total-assets', M(total));
  setEl('rv-total-liab',  `(${M(liab)})`);
  setEl('rv-equity',      M(equity));
  setEl('rv-per-share',   fmtPrice(perShare));

  // moat test
  const epvPs = D.epv.epvPerShare;
  const ratio  = epvPs / perShare;
  const moatColor = ratio >= 1.5 ? 'var(--green)' : ratio >= 1 ? 'var(--gold)' : 'var(--red)';
  setEl('rv-moat-ratio', `<span style="color:${moatColor}">${fmtDec(ratio,2)}×</span>`);
  setEl('rv-moat-label', ratio >= 1.5 ? 'Strong Moat' : ratio >= 1.0 ? 'Some Moat' : 'Questionable');
}

/* ════════════════════════════════════════════════════════════
   5. EPV
   ════════════════════════════════════════════════════════════ */
let epvState = {};

function renderEPV() {
  const epv = D.epv;
  epvState = {
    nopat: epv.nopatBase,
    wacc:  epv.waccBase,
    tax:   epv.taxBase
  };
  // sliders
  setSlider('sl-nopat', epv.nopatBase, Math.round(epv.nopatBase * 0.5), Math.round(epv.nopatBase * 1.8), 50);
  setSlider('sl-wacc',  epv.waccBase,  3, 20, 0.1);
  setSlider('sl-tax',   epv.taxBase,   10, 45, 1);
  updateEPVCalc();
  renderEPVBridge();
  renderSensitivity();
}

function setSlider(id, val, min, max, step) {
  const sl = document.getElementById(id);
  if (sl) { sl.min=min; sl.max=max; sl.step=step; sl.value=val; }
}

function onEPVSlider(field, val) {
  epvState[field] = parseFloat(val);
  const display = document.getElementById(`sl-${field}-val`);
  if (display) {
    if (field === 'nopat') display.textContent = `${sym()}${fmt(val)}M`;
    else display.textContent = `${fmtDec(parseFloat(val),1)}%`;
  }
  updateEPVCalc();
}

function updateEPVCalc() {
  const { nopat, wacc, tax } = epvState;
  const epv = D.epv;
  const nopatAdj = nopat * (1 - tax/100) / (1 - D.epv.taxBase/100); // rescale if tax changes
  // recompute: EPV Ops = NOPAT / WACC (D&A − MaintCapex net zero)
  const epvOps = (nopat / (wacc / 100));
  const epvEq  = epvOps + (epv.excessCash||0) + (epv.ltInv||0) + (epv.debt||0) + (epv.leases||0) + (epv.minorityInterest||0);
  const shares = D.overview.shares;
  const epvPs  = shares > 0 ? epvEq / shares : 0;
  const priceEpv = currentPrice / epvPs;
  const priceColor = priceEpv <= 1 ? 'var(--green)' : priceEpv <= 1.5 ? 'var(--gold)' : 'var(--red)';

  setEl('epv-ops',    M(Math.round(epvOps)));
  setEl('epv-equity', M(Math.round(epvEq)));
  setEl('epv-ps',     fmtPrice(epvPs));
  setEl('epv-price-ratio', `<span style="color:${priceColor}">Price / EPV = ${fmtDec(priceEpv,2)}×</span>`);

  // update bridge display values
  setEl('bridge-nopat',    `${sym()}${fmt(Math.round(nopat))}M`);
  setEl('bridge-wacc',     `${fmtDec(wacc,2)}%`);
  setEl('bridge-epv-ops',  `${sym()}${fmt(Math.round(epvOps))}M`);
  setEl('bridge-epv-eq',   `${sym()}${fmt(Math.round(epvEq))}M`);
  setEl('bridge-epv-ps',   fmtPrice(epvPs));
}

function renderEPVBridge() {
  const el = document.getElementById('epv-bridge');
  if (!el) return;
  const rows = D.epv.bridgeRows;
  if (!rows) return;
  let html = '';
  rows.forEach(r => {
    const cls = [r.bold?'fw':'', r.dim?'dim':'', r.gold?'gold':'', r.green?'green':'', r.red?'red':''].filter(Boolean).join(' ');
    const idAttr = r.id ? `id="${r.id}"` : '';
    html += `<div class="kv"><div class="row"><span class="k">${r.k}</span><span class="v ${cls}" ${idAttr}>${r.v}</span></div></div>`;
  });
  el.innerHTML = html;
}

function renderSensitivity() {
  const el = document.getElementById('epv-sensitivity');
  if (!el) return;
  const epv = D.epv;
  const shares = D.overview.shares;
  const waccVals = [5,6,7,8,9,10,11,12];
  const nopatMults = [0.7, 0.85, 1.0, 1.15, 1.3];
  let html = `<table class="fin-tbl sens-tbl">
    <thead><tr><th>NOPAT\\WACC</th>${waccVals.map(w=>`<th>${w}%</th>`).join('')}</tr></thead><tbody>`;
  nopatMults.forEach(m => {
    const n = epv.nopatBase * m;
    html += `<tr><th class="row-lbl">${sym()}${fmt(Math.round(n))}M</th>`;
    waccVals.forEach(w => {
      const ops = n / (w/100);
      const eq  = ops + (epv.excessCash||0) + (epv.ltInv||0) + (epv.debt||0) + (epv.leases||0) + (epv.minorityInterest||0);
      const ps  = shares > 0 ? eq / shares : 0;
      const isBase = Math.abs(m-1.0)<0.01 && Math.abs(w - epv.waccBase)<0.5;
      const ratio = currentPrice / ps;
      const bg = ratio <= 0.9 ? 'rgba(42,122,86,0.15)' : ratio <= 1.1 ? 'rgba(184,139,71,0.15)' : 'rgba(155,35,53,0.12)';
      html += `<td class="num-cell" style="background:${bg};${isBase?'font-weight:700;border:1px solid #b88b47':''}">${fmtPrice(ps)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table><p style="font-size:10px;color:#8a9098;margin-top:6px">Green = Price < EPV · Gold = ±10% · Red = Price > EPV</p>';
  el.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   6. ROIC & CAPITAL
   ════════════════════════════════════════════════════════════ */
function renderROIC() {
  const roic = D.roic;
  const years = D.financials.years;

  setEl('roic-latest',  Pct(roic.roicLatest));
  setEl('roic-3yr',     Pct(roic.roic3yr));
  const spread = roic.roicLatest - D.overview.wacc*100;
  setEl('roic-spread',  `${spread >= 0 ? '+' : ''}${Pct(spread)}`);
  setEl('roic-marginal', Pct(roic.marginalRoic));
  setEl('roic-ic-latest', M(roic.icHistory ? roic.icHistory[roic.icHistory.length-1] : null));

  // IC breakdown cards
  if (roic.investedCapital) {
    const icEl = document.getElementById('roic-ic-cards');
    if (icEl) {
      icEl.innerHTML = roic.investedCapital.map(c => `
        <div class="card"><div class="clbl">${c.label}</div>
        <div class="cval ${c.value < 0 ? 'red':'gold'}">${M(c.value)}</div></div>
      `).join('');
    }
  }

  // table
  renderTable('tbl-roic', roic.icRows, years, D.financials);

  // charts
  destroyChart('c-roic'); destroyChart('c-ic');
  const c1 = document.getElementById('c-roic');
  if (c1 && roic.roicHistory) {
    charts['c-roic'] = new Chart(c1, {
      type:'line', data:{ labels:years,
        datasets:[
          {label:'ROIC %', data:roic.roicHistory, borderColor:'#b88b47', backgroundColor:'rgba(184,139,71,0.1)', tension:0.3, fill:true},
          {label:'WACC %', data:Array(years.length).fill(D.overview.wacc*100), borderColor:'#9b2335', borderDash:[5,3], pointRadius:0},
        ]},
      options: chartOpts('%','ROIC vs WACC (%)')
    });
  }
  const c2 = document.getElementById('c-ic');
  if (c2 && roic.icHistory && roic.nopatHistory) {
    charts['c-ic'] = new Chart(c2, {
      type:'bar', data:{ labels:years,
        datasets:[
          {label:'Invested Capital', data:roic.icHistory, backgroundColor:'rgba(27,38,66,0.7)', yAxisID:'y'},
          {label:'NOPAT (DCE)',      data:roic.nopatHistory, backgroundColor:'rgba(184,139,71,0.8)', yAxisID:'y'},
        ]},
      options: chartOpts(`${sym()}M`,`Invested Capital vs NOPAT (${sym()}M)`)
    });
  }
}

/* ════════════════════════════════════════════════════════════
   7. IMPLIED IRR
   ════════════════════════════════════════════════════════════ */
let irrState = {};

function renderIrr() {
  const irr = D.irr;
  irrState = { ...irr };

  // sliders
  setSlider('sl-irr-roic',  irr.selectedRoic, 5, 200, 0.5);
  setSlider('sl-irr-organic', irr.organicGrowth, 0, 15, 0.5);
  setSlider('sl-irr-exit',  irr.exitMultiple, 8, 50, 1);
  setSlider('sl-irr-buybacks', irr.buybacks || 0, 0, Math.round(irr.ev * 0.1 / 1000) * 1000, 100);
  setSlider('sl-irr-horizon', irr.horizon, 3, 10, 1);
  updateIRRCalc();
}

function onIRRSlider(field, val) {
  irrState[field] = parseFloat(val);
  const dispEl = document.getElementById(`sl-irr-${field}-val`);
  if (dispEl) {
    if (field === 'buybacks') dispEl.textContent = `${sym()}${fmt(val)}M`;
    else if (field === 'exit') dispEl.textContent = `${val}×`;
    else if (field === 'horizon') dispEl.textContent = `${val} yr`;
    else dispEl.textContent = `${fmtDec(parseFloat(val),1)}%`;
  }
  updateIRRCalc();
}

function updateIRRCalc() {
  const s = irrState;
  const nopat = D.epv.nopatBase;
  const ev = s.ev || D.irr.ev;

  // Distribution yield = (dividends + buybacks + interest) / EV
  const divs = s.dividends || 0;
  const bks  = s.buybacks  || 0;
  const int_ = s.interest  || 0;
  const distYield = (divs + bks + int_) / ev * 100;

  // Reinvestment growth = reinvRate * selectedROIC
  const reinvGrowth = (s.reinvRate || s.reinvGrowth || 0) * (s.selectedRoic / 100);

  // Multiple impact (annualized) = (exitMult/actualMult)^(1/horizon) - 1
  const actualMult = ev / nopat;
  const multImpact = (Math.pow(s.exitMultiple / actualMult, 1/s.horizon) - 1) * 100;

  // Organic growth
  const organic = s.organicGrowth;

  // D/E effect = deRatio * netBorrowCost (typically negative for high-debt)
  const deEffect = (s.dCapital || 0) / 100 * (s.netBorrowCost || 0);

  // Total equity return
  const totalIRR = distYield + reinvGrowth + organic + multImpact - deEffect;
  const mos = totalIRR - s.hurdle;

  const irrColor = totalIRR >= s.hurdle ? 'var(--green)' : 'var(--red)';
  const mosSign  = mos >= 0 ? '+' : '';
  const mosCls   = mos >= 0 ? 'green' : 'red';

  setEl('irr-dist-yield',   Pct(distYield));
  setEl('irr-reinv-growth', Pct(reinvGrowth));
  setEl('irr-organic',      Pct(organic));
  setEl('irr-mult-impact',  Pct(multImpact));
  setEl('irr-total',        `<span style="color:${irrColor};font-size:24px;font-weight:700">${Pct(totalIRR)}</span>`);
  setEl('irr-hurdle',       Pct(s.hurdle));
  setEl('irr-mos',          `<span class="${mosCls}">${mosSign}${Pct(mos)}</span>`);

  // bar widths (normalize to 25% = 100%)
  function barW(val) { return Math.min(100, Math.max(0, Math.abs(val) / 25 * 100)); }
  ['dist-yield','reinv-growth','organic','mult-impact'].forEach(k => {
    const bar = document.getElementById(`irr-bar-${k}`);
    if (bar) {
      const v = k==='dist-yield' ? distYield : k==='reinv-growth' ? reinvGrowth : k==='organic' ? organic : multImpact;
      bar.style.width = barW(v) + '%';
      bar.style.backgroundColor = v >= 0 ? '#2a7a56' : '#9b2335';
    }
  });
}

/* ════════════════════════════════════════════════════════════
   8. HEALTH CHECK
   ════════════════════════════════════════════════════════════ */
function renderHealth() {
  const hc = D.healthCheck;
  setEl('hc-pass',    hc.passCount);
  setEl('hc-fail',    hc.failCount);
  setEl('hc-monitor', hc.monitorCount);

  // table
  const el = document.getElementById('hc-table-body');
  if (el && hc.metrics) {
    let lastCat = '';
    let html = '';
    hc.metrics.forEach(m => {
      if (m.category !== lastCat) {
        html += `<tr class="cat"><td colspan="5">${m.category}</td></tr>`;
        lastCat = m.category;
      }
      const statusCls = m.status === 'pass' ? 'pass' : m.status === 'fail' ? 'fail' : 'monitor bo';
      const statusLbl = m.status === 'pass' ? '✓ PASS' : m.status === 'fail' ? '✗ FAIL' : '≈ MONITOR';
      html += `<tr>
        <td>${m.label}</td>
        <td class="num-cell">${m.value}</td>
        <td class="num-cell">${m.threshold}</td>
        <td><span class="${statusCls}">${statusLbl}</span></td>
        <td class="dim">${m.rationale || ''}</td>
      </tr>`;
    });
    el.innerHTML = html;
  }

  // radar chart
  destroyChart('c-radar');
  const rc = document.getElementById('c-radar');
  if (rc && hc.radarLabels && hc.radarScores) {
    charts['c-radar'] = new Chart(rc, {
      type: 'radar',
      data: {
        labels: hc.radarLabels.map(l => l.replace('\\n', '\n')),
        datasets: [{
          label: D.ticker,
          data: hc.radarScores,
          borderColor: '#b88b47',
          backgroundColor: 'rgba(184,139,71,0.15)',
          pointBackgroundColor: '#b88b47',
          pointRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        scales: { r: {
          beginAtZero: true, max: 100,
          ticks: { font: {size: 9}, color: '#8a9098', stepSize: 25 },
          pointLabels: { font: {size: 10}, color: '#1b2642' },
          grid: { color: 'rgba(27,38,66,0.08)' },
          angleLines: { color: 'rgba(27,38,66,0.08)' },
        }},
        plugins: { legend: { display: false } }
      }
    });
  }
}

/* ════════════════════════════════════════════════════════════
   9. CIO DECISIONS
   ════════════════════════════════════════════════════════════ */
function renderAudit() {
  const el = document.getElementById('audit-list');
  if (!el || !D.cioDecisions) return;
  let html = '';
  D.cioDecisions.forEach(d => {
    html += `<div class="arow">
      <div class="anum">${d.id}</div>
      <div>
        <div class="atitle">${d.decision} — <span style="color:var(--gold)">${d.value}</span></div>
        <div class="adesc">${d.rationale}</div>
      </div>
    </div>`;
  });
  el.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   10. SUMMARY
   ════════════════════════════════════════════════════════════ */
function renderSummary() {
  const ts = D.thesisSummary;
  const ov = D.overview;
  const epv = D.epv;

  setEl('memo-narrative', ts.narrative || '');

  // ── KPI Hero strip (6 numbers that matter) ─────────────────
  const mosRaw = ts.marginOfSafety;
  const mosColor = mosRaw >= 0 ? 'var(--green)' : 'var(--red)';
  const irrColor = ts.impliedIrr >= D.irr.hurdle ? 'var(--green)' : 'var(--red)';
  const peRatio  = ts.priceEpvRatio;
  const peColor  = peRatio < 1 ? 'var(--green)' : peRatio < 1.2 ? 'var(--gold)' : 'var(--red)';
  const roicVal  = ov.roic3yr > 2 ? ov.roic3yr*100 : ov.roic3yr;
  const wacc3    = D.overview.wacc*100;
  const roicColor = roicVal > wacc3 ? 'var(--green)' : 'var(--gray-mid)';

  const kpis = [
    { lbl:'Margin of Safety', val:`${mosRaw>=0?'+':''}${Pct(mosRaw)}`, color:mosColor, sub:`vs. hurdle ${Pct(D.irr.hurdle)}` },
    { lbl:'Implied IRR',      val:Pct(ts.impliedIrr),                  color:irrColor, sub:`Hurdle ${Pct(D.irr.hurdle)}` },
    { lbl:'Price / EPV',      val:Mul(peRatio),                        color:peColor,  sub:`EPV ${fmtPrice(epv.epvPerShare)}` },
    { lbl:'EPV / RV',         val:Mul(ts.epvRvRatio),                  color:'var(--navy)', sub:`Quality lens` },
    { lbl:'ROIC 3yr avg',     val:Pct(roicVal),                        color:roicColor, sub:`WACC ${Pct(wacc3)}` },
    { lbl:'Market Cap',       val:B(ov.marketCap),                     color:'var(--navy)', sub:`EV ${B(ov.ev)}` },
  ];
  const kpiEl = document.getElementById('summary-kpis');
  if (kpiEl) {
    kpiEl.innerHTML = kpis.map(k => `
      <div class="card" style="padding:14px 16px">
        <div class="clbl" style="font-size:9px">${k.lbl}</div>
        <div style="font-size:22px;font-weight:700;color:${k.color};letter-spacing:-0.02em;margin-top:4px">${k.val}</div>
        <div style="font-size:11px;color:var(--gray-mid);margin-top:2px">${k.sub}</div>
      </div>`).join('');
  }

  // ── Themed metric tables ──────────────────────────────────
  const identity = [
    ['Company',        D.name],
    ['Ticker',         D.ticker],
    ['Exchange',       D.exchange],
    ['CEO',            ov.ceo],
    ['HQ',             ov.headquarters],
    ['Employees',      fmt(ov.employees)],
    ['Valuation Date', D.valuationDate],
  ];
  const valuation = [
    ['Stock Price',    fmtPrice(currentPrice)],
    ['EPV / Share',    fmtPrice(epv.epvPerShare)],
    ['RV / Share',     fmtPrice(D.rv.rvPerShare)],
    ['Price / EPV',    Mul(ts.priceEpvRatio)],
    ['EPV / RV',       Mul(ts.epvRvRatio)],
    ['Implied IRR',    Pct(ts.impliedIrr)],
    ['Hurdle Rate',    Pct(D.irr.hurdle)],
    ['MoS',            `${mosRaw>=0?'+':''}${Pct(mosRaw)}`],
    ['WACC',           Pct(wacc3)],
  ];
  const operations = [
    ['Revenue FY2025', M(ov.revenue)],
    ['Op Margin',      Pct(ov.operMargin*100)],
    ['FCF FY2025',     M(ov.fcfLatest)],
    ['FCF Margin',     Pct(ov.fcfMargin*100)],
    ['ROIC (latest)',  Pct(ov.roicLatest > 2 ? ov.roicLatest*100 : ov.roicLatest)],
    ['ROIC 3yr avg',   Pct(roicVal)],
  ];

  const fillRows = (id, rows) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = rows.map(r => `
      <div class="memo-row">
        <span class="mk">${r[0]}</span>
        <span class="mv">${r[1]}</span>
      </div>`).join('');
  };
  fillRows('summary-identity',   identity);
  fillRows('summary-valuation',  valuation);
  fillRows('summary-operations', operations);

  // Columbia ladder
  renderLadder();

  // Decision Journal handoff: smart single button — opens new entry if no
  // active decision yet for this ticker, otherwise jumps to existing entry.
  refreshJournalButton();
}

async function refreshJournalButton() {
  const btn   = document.getElementById('journal-action-btn');
  const label = document.getElementById('journal-status-label');
  if (!btn) return;
  const ticker = D.ticker || '';
  const tkEnc = encodeURIComponent(ticker);

  // Default state — assume new entry. Updated below if check finds existing.
  btn.href = `/journal?action=new&ticker=${tkEnc}`;
  btn.setAttribute('data-mode', 'new');
  btn.style.background   = 'var(--navy)';
  btn.style.borderColor  = 'var(--navy)';
  btn.firstChild && (btn.childNodes[0].nodeValue = 'Open Decision Journal ');
  if (label) label.textContent = '';

  try {
    const r = await fetch(`/api/journal-check?ticker=${tkEnc}`);
    if (!r.ok) return;
    const data = await r.json();
    if (!data || !data.exists || !data.item) return;

    const it = data.item;
    const type = String(it.decision_type || '').toUpperCase();
    const date = it.decision_date ? String(it.decision_date).slice(0, 10) : '';

    // Existing decision — switch to View mode (green action)
    btn.href = `/journal?focus=${encodeURIComponent(it.id)}&ticker=${tkEnc}`;
    btn.setAttribute('data-mode', 'view');
    btn.style.background  = '#15803d';
    btn.style.borderColor = '#15803d';
    btn.childNodes[0].nodeValue = `View Decision: ${type} `;
    if (label) label.textContent = date ? `Registered ${date}` : 'Registered';
  } catch (_) { /* silent fallback to new mode */ }
}

function renderLadder() {
  const rv   = D.rv.rvPerShare;
  const epv  = D.epv.epvPerShare;
  const mkt  = currentPrice;
  const maxV = Math.max(rv, epv, mkt) * 1.05;
  const hMax = 200;
  function h(v) { return Math.round(v / maxV * hMax); }

  const el = document.getElementById('columbia-ladder');
  if (!el) return;
  el.innerHTML = `
    <div class="lcol">
      <div class="lbar nav" style="height:${h(rv)}px"></div>
      <div class="lval">${fmtPrice(rv)}</div>
      <div class="llbl">Reproduction<br>Value</div>
      <div class="lnote">Floor</div>
    </div>
    <div class="lcol">
      <div class="lbar epv" style="height:${h(epv)}px"></div>
      <div class="lval">${fmtPrice(epv)}</div>
      <div class="llbl">EPV<br>(No Growth)</div>
      <div class="lnote">Moat Proxy</div>
    </div>
    <div class="lcol">
      <div class="lbar mkt" style="height:${h(mkt)}px"></div>
      <div class="lval">${fmtPrice(mkt)}</div>
      <div class="llbl">Market<br>Price</div>
      <div class="lnote">Today</div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════
   CHART.JS DEFAULTS
   ════════════════════════════════════════════════════════════ */
function chartOpts(unit, title) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: { position: 'bottom', labels: { font: {size:10}, color:'#606060', boxWidth:12 } },
      title: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => {
            const v = ctx.parsed.y;
            if (unit === '%') return ` ${ctx.dataset.label}: ${fmtDec(v,1)}%`;
            return ` ${ctx.dataset.label}: ${sym()}${fmt(v)}M`;
          }
        }
      }
    },
    scales: {
      x: { ticks: { font:{size:10}, color:'#8a9098' }, grid: { display:false } },
      y: { ticks: { font:{size:10}, color:'#8a9098',
           callback: v => unit==='%' ? `${v}%` : `${sym()}${v>=1000?(v/1000).toFixed(0)+'K':v}` },
           grid: { color:'rgba(27,38,66,0.05)' } }
    }
  };
}

/* ── start ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initDashboard);
