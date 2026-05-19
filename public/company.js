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
    {id:'health',      label:'Health Checks'},
    {id:'financials',  label:'Financials'},
    {id:'audit',       label:'CIO Decisions'},
    {id:'adj',         label:'Adjustments'},
    {id:'rv',          label:'Reproduction Value'},
    {id:'epv',         label:'EPV'},
    {id:'roic',        label:'ROIC and Capital'},
    {id:'irr',         label:'Implied IRR'},
    {id:'thesis',      label:'Thesis Health'},
    {id:'vr',          label:'Valuation Report', external: D.documents.valuationReportUrl, style:'color:var(--gold);font-weight:600'},
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
    case 'thesis':     renderThesis(); break;
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
  const mult = ov.multiples || {};

  /* ----- 1. Company Profile ----- */
  setEl('prof-name',      D.name || '—');
  setEl('prof-ticker',    `${D.ticker || '—'} / ${D.exchange || '—'}`);
  setEl('prof-sector',    ov.sector || D.industry || '—');
  setEl('prof-bizmodel',  ov.businessModel || '—');
  setEl('prof-fye',       ov.fiscalYearEnd || '—');
  setEl('prof-ceo',       ov.ceo || '—');
  setEl('prof-hq',        ov.headquarters || '—');
  setEl('prof-employees', ov.employees != null ? `~${fmt(ov.employees)}` : '—');
  setEl('prof-valdate',   D.valuationDate || '—');

  /* ----- 2. Market Data ----- */
  // Use live currentPrice if available, else snapshot stockPrice
  const livePrice = (typeof currentPrice === 'number' && currentPrice > 0) ? currentPrice : ov.stockPrice;
  const isLive = (livePrice != null && ov.stockPrice != null && Math.abs(livePrice - ov.stockPrice) > 0.01);
  setEl('md-price', fmtPrice(livePrice));
  setEl('md-price-sub', isLive
    ? `Live · snapshot ${fmtPrice(ov.stockPrice)} (${D.valuationDate || ''})`
    : (ov.priceNote || `Cotización ${D.valuationDate || ''}`));
  setEl('md-shares', fmtDec(ov.shares, 1));
  setEl('md-shares-sub', ov.sharesNote || `10-K ${D.fiscalYear || ''}`);

  // Recalculate market cap & EV with live price
  const mcapLive = (ov.shares != null && livePrice != null) ? ov.shares * livePrice : ov.marketCap;
  const evLive   = mcapLive + (ov.debt || 0) + (ov.leases || 0) - (ov.cash || 0);
  setEl('md-mcap', B(mcapLive));
  setEl('md-mcap-sub', isLive ? `Snapshot ${B(ov.marketCap)} · live` : (ov.marketCapNote || 'Precio × Acciones'));
  setEl('md-ev', B(evLive));
  setEl('md-ev-sub', isLive ? `Snapshot ${B(ov.ev)} · live` : (ov.evNote || 'MCap + Debt + Leases − Cash'));

  setEl('md-debt',     M(ov.debt));
  setEl('md-debt-sub', ov.debtNote || '—');
  setEl('md-leases',   M(ov.leases));
  setEl('md-leases-sub', ov.leasesNote || '—');
  setEl('md-cash',     M(ov.cash));
  setEl('md-cash-sub', ov.cashNote || '—');
  const netDebt = (Number(ov.debt) || 0) + (Number(ov.leases) || 0) - (Number(ov.cash) || 0);
  setEl('md-netdebt',     M(netDebt));
  setEl('md-netdebt-sub', ov.netDebtNote || 'Debt + Leases − Cash');

  /* ----- 3. Key Financials (FY cerrado) ----- */
  setEl('kf-fy-label', `Métricas Financieras Clave (${D.fiscalYear || 'FY'})`);
  setEl('kf-revenue',   M(ov.revenue));
  setEl('kf-opinc',     M(ov.operatingIncome));
  setEl('kf-opmargin',  ov.operMargin != null ? Pct(ov.operMargin*100) : '—');
  setEl('kf-ebitda',    M(ov.ebitda));
  setEl('kf-ni',        M(ov.netIncome));
  setEl('kf-eps',       ov.epsDiluted != null ? `${sym_}${fmtDec(ov.epsDiluted, 2)}` : '—');
  setEl('kf-cfo',       M(ov.cfo));
  setEl('kf-capex',     M(ov.capex));
  setEl('kf-fcf',       M(ov.fcfLatest));
  setEl('kf-fcfmargin', ov.fcfMargin != null ? Pct(ov.fcfMargin*100) : '—');
  setEl('kf-da',        M(ov.da));
  setEl('kf-sbc',       M(ov.sbc));

  function yoyHtml(v) {
    if (v == null) return '<span class="v" style="color:var(--gray-mid)">Pendiente</span>';
    const sign = v >= 0 ? '+' : '';
    const cls  = v >= 0 ? 'green' : 'red';
    return `<span class="${cls}">${sign}${(v*100).toFixed(1)}%</span>`;
  }
  setEl('kf-rev-yoy',    yoyHtml(ov.revenueGrowthYoY));
  setEl('kf-ebitda-yoy', yoyHtml(ov.ebitdaGrowthYoY));
  setEl('kf-fcf-yoy',    yoyHtml(ov.fcfGrowthYoY));

  /* ----- 4. Valuation Multiples (snapshot + live) ----- */
  setEl('mult-snap-date', `(${D.valuationDate || ''})`);
  // Live recalculations using live mcap / ev, but FY denominators unchanged
  const liveMult = {
    peTtm:    (mcapLive != null && ov.netIncome) ? mcapLive / ov.netIncome : null,
    evEbitda: (evLive != null && ov.ebitda)     ? evLive / ov.ebitda      : null,
    evRevenue:(evLive != null && ov.revenue)    ? evLive / ov.revenue     : null,
    pFcf:     (mcapLive != null && ov.fcfLatest)? mcapLive / ov.fcfLatest : null,
    priceBook: null,   // requires book value, not derivable here
    dividendYield: null
  };
  const multRows = [
    { key:'peTtm',         label:'P/E (TTM)',      kind:'mul' },
    { key:'evEbitda',      label:'EV / EBITDA',    kind:'mul' },
    { key:'evRevenue',     label:'EV / Revenue',   kind:'mul' },
    { key:'pFcf',          label:'P / FCF',        kind:'mul' },
    { key:'priceBook',     label:'Price / Book',   kind:'mul' },
    { key:'dividendYield', label:'Dividend Yield', kind:'pct' }
  ];
  function fmtMul(v, kind) {
    if (v == null) return '<span style="color:var(--gray-mid);font-style:italic">Pendiente</span>';
    return kind === 'pct' ? `${(v*100).toFixed(2)}%` : `${v.toFixed(2)}×`;
  }
  function deltaHtml(snap, live) {
    if (snap == null || live == null) return '<span style="color:var(--gray-mid)">—</span>';
    const d = (live - snap) / snap;
    if (Math.abs(d) < 0.005) return '<span style="color:var(--gray-mid)">flat</span>';
    const sign = d >= 0 ? '+' : '';
    const cls = d >= 0 ? 'red' : 'green';  // re-rating up = caro (rojo), down = barato (verde)
    return `<span class="${cls}">${sign}${(d*100).toFixed(1)}%</span>`;
  }
  let multBodyHtml = '';
  multRows.forEach((r,i) => {
    const snap = mult[r.key];
    const live = liveMult[r.key] != null ? liveMult[r.key] : snap;  // fallback to snapshot if not derivable
    const isLiveDerived = liveMult[r.key] != null;
    const liveCell = isLiveDerived
      ? fmtMul(live, r.kind)
      : '<span style="color:var(--gray-mid);font-style:italic">—</span>';
    multBodyHtml += `
      <tr style="border-bottom:1px solid var(--rule)">
        <td style="padding:9px 18px;color:var(--gray-txt)">${r.label}</td>
        <td style="padding:9px 18px;text-align:right;font-weight:600">${fmtMul(snap, r.kind)}</td>
        <td style="padding:9px 18px;text-align:right;font-weight:600">${liveCell}</td>
        <td style="padding:9px 18px;text-align:right">${isLiveDerived ? deltaHtml(snap, live) : '<span style="color:var(--gray-mid)">—</span>'}</td>
      </tr>`;
  });
  setEl('mult-tbody', multBodyHtml);

  /* ----- 5. Model inputs (moved to Summary tab but rendered here for safety) ----- */
  const adj = D.adj;
  const irr = D.irr;
  const cio  = D.cioDecisions;
  function cioVal(id) { const r = cio.find(c=>c.id===id); return r ? r.value : '—'; }
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
  // market context charts (price 5Y vs EPV, P/E hist) — async
  renderMarketContext().catch(err => console.warn('[market-context]', err));
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

  // c4: Capital Deployment donut (FY latest) — base CFO, 4 usos
  destroyChart('c4');
  const ctx4 = document.getElementById('c4');
  if (ctx4) {
    const last = (arr) => Array.isArray(arr) && arr.length ? (arr[arr.length-1] || 0) : 0;
    const cfo   = last(fin.cfo);
    const capex = Math.abs(last(fin.capex || fin.capExpenditures || [])) || 0;
    // CapEx can come negative in CF; in this dashboard fin.capex isn't separately exposed.
    // Derive from CFO - FCF (since FCF = CFO - CapEx) if not available.
    const capexDerived = capex || Math.max(0, last(fin.cfo) - last(fin.fcf));
    const bk    = Math.abs(last(fin.buybacks));
    const div   = Math.abs(last(fin.dividends));
    const used  = capexDerived + bk + div;
    const netCash = cfo - used; // positivo: incrementa caja / paga deuda; negativo: financiado con caja
    const labels = ['CapEx', 'Buybacks', 'Dividends'];
    const data   = [capexDerived, bk, div];
    const colors = ['#7a5a2e', '#b88b47', '#2a7a56'];
    if (netCash >= 0) {
      labels.push('Net Cash / Debt Paydown');
      data.push(netCash);
      colors.push('#1b2642');
    } else {
      labels.push('Financed from Cash');
      data.push(Math.abs(netCash));
      colors.push('#b91c1c');
    }
    charts['c4'] = new Chart(ctx4, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom', labels: { font: {size:11}, color:'#606060', boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (c) => {
                const v = Number(c.parsed) || 0;
                const pct = cfo > 0 ? (v / cfo * 100).toFixed(0) : '0';
                return `${c.label}: ${sym()}${fmt(v)}M (${pct}% del CFO)`;
              }
            }
          },
          title: {
            display: true,
            text: `Base: CFO ${sym()}${fmt(cfo)}M`,
            color: '#606060', font: { size: 10, weight: 'normal' }, padding: { bottom: 4 }
          }
        }
      }
    });
  }
}


/* ───── Market Context: Stock Price 5Y vs EPV + P/E histórico ───── */
async function renderMarketContext() {
  const ticker = (D && D.ticker) || (D && D.overview && D.overview.ticker);
  if (!ticker) return;
  const priceCtx = document.getElementById('c-price');
  const peCtx    = document.getElementById('c-pe');
  if (!priceCtx && !peCtx) return;

  let payload;
  try {
    const r = await fetch(`/api/company-price-series?ticker=${encodeURIComponent(ticker)}&years=5`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    payload = await r.json();
  } catch (e) {
    setEl('c-price-note', 'Datos de precio no disponibles');
    setEl('c-pe-note', 'Datos de precio no disponibles');
    return;
  }
  const { dates, prices, pe, reference } = payload;
  if (!Array.isArray(dates) || !dates.length) {
    setEl('c-price-note', 'Sin datos históricos');
    setEl('c-pe-note', 'Sin datos históricos');
    return;
  }

  // A. Stock Price 5Y vs EPV vs BUY zone
  destroyChart('c-price');
  if (priceCtx) {
    const epv = reference && reference.epvPerShare;
    const buy = reference && reference.buyZone;
    const datasets = [{
      label: 'Precio',
      data: prices,
      borderColor: '#1b2642',
      backgroundColor: 'rgba(27,38,66,0.06)',
      borderWidth: 1.6,
      tension: 0.15,
      pointRadius: 0,
      fill: true,
    }];
    if (epv) datasets.push({
      label: `EPV / Share ($${epv.toFixed(2)})`,
      data: prices.map(() => epv),
      borderColor: '#b88b47',
      borderWidth: 1.3,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
    });
    if (buy) datasets.push({
      label: `BUY Zone (≤$${buy.toFixed(2)})`,
      data: prices.map(() => buy),
      borderColor: '#2a7a56',
      borderWidth: 1.3,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
    });
    charts['c-price'] = new Chart(priceCtx, {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { font: {size:10}, color:'#606060', boxWidth: 14 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: $${Number(c.parsed.y).toFixed(2)}` } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, font: {size:10}, color:'#999' }, grid: { display: false } },
          y: { ticks: { font: {size:10}, color:'#999', callback: (v) => '$'+v }, grid: { color:'#f0f0f0' } },
        },
      },
    });
    const last = prices[prices.length - 1];
    const mosNow = (epv && last) ? ((epv - last) / epv * 100) : null;
    const mosTxt = mosNow != null ? `· MoS hoy: ${mosNow >= 0 ? '+' : ''}${mosNow.toFixed(1)}%` : '';
    setEl('c-price-note', `Último: $${(last||0).toFixed(2)} · EPV: $${(epv||0).toFixed(2)} · BUY ≤ $${(buy||0).toFixed(2)} ${mosTxt}`);
  }

  // B. P/E TTM proxy (5Y)
  destroyChart('c-pe');
  if (peCtx) {
    const peClean = pe.map(v => (v != null && isFinite(v)) ? v : null);
    const median  = reference && reference.peMedian;
    const current = reference && reference.peCurrent;
    const datasets = [{
      label: 'P/E TTM proxy',
      data: peClean,
      borderColor: '#1b2642',
      backgroundColor: 'rgba(27,38,66,0.06)',
      borderWidth: 1.6,
      tension: 0.15,
      pointRadius: 0,
      fill: true,
      spanGaps: true,
    }];
    if (median) datasets.push({
      label: `Mediana 5Y (${median.toFixed(1)}×)`,
      data: peClean.map(() => median),
      borderColor: '#b88b47',
      borderWidth: 1.3,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
    });
    charts['c-pe'] = new Chart(peCtx, {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { font: {size:10}, color:'#606060', boxWidth: 14 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(2)}×` } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, font: {size:10}, color:'#999' }, grid: { display: false } },
          y: { ticks: { font: {size:10}, color:'#999', callback: (v) => v+'×' }, grid: { color:'#f0f0f0' } },
        },
      },
    });
    const vsMed = (current && median) ? ((current - median) / median * 100) : null;
    const vsTxt = vsMed != null ? `· ${vsMed >= 0 ? '+' : ''}${vsMed.toFixed(0)}% vs mediana` : '';
    setEl('c-pe-note', `Actual: ${(current||0).toFixed(1)}× · Mediana 5Y: ${(median||0).toFixed(1)}× ${vsTxt}`);
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
    // Margin rows render indented so they read as a child of the driver row above
    const lblStyle = r.t === 'margin' ? ' style="padding-left:22px"' : '';
    html += `<tr class="${cls}"><td class="row-lbl"${lblStyle}>${r.l}</td>`;
    (r.v || Array(years.length).fill(null)).forEach(v => {
      if (v == null) { html += `<td class="num-cell dim">—</td>`; return; }
      let disp;
      if (r.t === 'margin') {
        // BS Current Ratio se muestra como 1.42x (sin %)
        disp = r.isRatio ? `${fmtDec(v,2)}x` : `${fmtDec(v,1)}%`;
      } else if (r.fmt === 'price') {
        disp = `$${fmtDec(v,2)}`;
      } else {
        disp = v < 0 ? `(${fmt(Math.abs(v))})` : fmt(v);
      }
      const neg = (r.neg && v > 0) || v < 0;
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
        // Orden lógico: GAAP → normalizado (DCE) → derivado (FCF)
        {label:'Net Income', data:fin.netIncome,     backgroundColor:'rgba(27,38,66,0.7)'},
        {label:'NOPAT (DCE)',data:fin.nopatAdjusted, backgroundColor:'rgba(184,139,71,0.8)'},
        {label:'FCF',        data:fin.fcf,           backgroundColor:'rgba(42,122,86,0.75)'},
      ]},
    options: chartOpts(`${sym()}M`, `Net Income / NOPAT / FCF (${sym()}M)`)
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
        // Orden lógico: input (CFO) → reinversión (CapEx) → resultado (FCF = CFO − CapEx)
        {label:'CFO',   data:fin.cfo,                                  backgroundColor:'rgba(27,38,66,0.7)'},
        {label:'CapEx', data:fin.fcf.map((f,i)=>fin.cfo[i]-f),          backgroundColor:'rgba(155,35,53,0.5)'},
        {label:'FCF',   data:fin.fcf,                                  backgroundColor:'rgba(42,122,86,0.75)'},
      ]},
    options: chartOpts(`${sym()}M`, `CFO / CapEx / FCF (${sym()}M)`)
  });
}

/* ════════════════════════════════════════════════════════════
   3. ADJUSTMENTS — CIO DEEP-DIVE
   ════════════════════════════════════════════════════════════ */
function renderAdj() {
  const adj   = D.adj || {};
  const fin   = D.financials || {};
  const years = fin.years || [];

  /* ---------- 1. Fallback derivations from isRows when needed ---------- */
  const isRows = fin.isRows || [];
  const findRow = (re) => isRows.find(r => re.test(r.l));
  const etrRow  = findRow(/Effective Tax Rate/i);
  const etrHist = (adj.etrHistory && adj.etrHistory.length) ? adj.etrHistory : (etrRow ? etrRow.v.map(v => v) : []);
  const etrYears = adj.etrYears || years;
  const etrMedian = etrHist.length ? (() => { const s=[...etrHist].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; })() : null;

  const smGrowthHist = adj.smGrowthHistory || [];
  const nopatHist    = adj.nopatHistory || [];
  const cohort       = adj.smCohortMatrix;
  const bridge       = adj.nopatBridge;

  /* ---------- 2. Hero waterfall (Bloque 1) ---------- */
  const heroYear = bridge ? bridge.year : (years.length ? years[years.length-1] : '—');
  setEl('adj-hero-year', heroYear);
  if (bridge && bridge.steps) {
    const steps = bridge.steps;
    let running = 0;
    const labels = [];
    const floatBars = [];
    const colors = [];
    steps.forEach((s) => {
      labels.push(s.label);
      if (s.kind === 'start')       { floatBars.push([0, s.v]);            running = s.v;            colors.push('#1B2642'); }
      else if (s.kind === 'add')    { floatBars.push([running, running+s.v]); running += s.v;       colors.push('#2A7A56'); }
      else if (s.kind === 'sub')    { floatBars.push([running+s.v, running]); running += s.v;       colors.push('#9B2335'); }
      else if (s.kind === 'subtotal'){ floatBars.push([0, s.v]);            running = s.v;          colors.push('rgba(27,38,66,0.6)'); }
      else if (s.kind === 'end')    { floatBars.push([0, s.v]);             running = s.v;          colors.push('#B88B47'); }
    });
    destroyChart('c-nopat-bridge');
    const ctx = document.getElementById('c-nopat-bridge');
    if (ctx) {
      // Custom plugin: draw value labels on top of each bar + connector lines
      const waterfallLabels = {
        id: 'waterfallLabels',
        afterDatasetsDraw(chart) {
          const { ctx: cc, data } = chart;
          const meta = chart.getDatasetMeta(0);
          cc.save();
          cc.font = '600 11px "Helvetica Neue", Helvetica, Arial';
          cc.fillStyle = '#1B2642';
          cc.textAlign = 'center';
          meta.data.forEach((bar, i) => {
            const s = steps[i];
            const val = s.v;
            const sign = s.kind === 'add' ? '+' : (s.kind === 'sub' ? '' : '');
            const display = `${sign}${sym()}${fmt(Math.abs(val))}M`;
            const { x, y } = bar.tooltipPosition();
            // For sub bars (tax), the top of visible bar is at y of upper of the float range -> use bar.y
            const topY = bar.y - 6;
            cc.fillText(display, x, topY);
          });
          // Connector dashed lines between consecutive bars
          cc.strokeStyle = 'rgba(27,38,66,0.3)';
          cc.lineWidth = 1;
          cc.setLineDash([3, 3]);
          for (let i = 0; i < meta.data.length - 1; i++) {
            const cur = meta.data[i];
            const nxt = meta.data[i+1];
            const f1 = floatBars[i];
            const f2 = floatBars[i+1];
            // For 'add' the top of current is running value; for 'sub' bottom of current is end value; etc.
            const curTop = cur.base !== undefined ? Math.min(cur.y, cur.base) : cur.y;
            const nxtBot = nxt.base !== undefined ? Math.max(nxt.y, nxt.base) : nxt.y;
            // Simpler: connect from end of current bar (the running value after step) to start of next bar
            const curRight = cur.x + cur.width/2;
            const nxtLeft = nxt.x - nxt.width/2;
            // Running value y for current step:
            const runY = cur.base !== undefined ? (steps[i].kind === 'sub' ? cur.y : (steps[i].kind === 'add' ? cur.y : cur.y)) : cur.y;
            cc.beginPath();
            cc.moveTo(curRight, runY);
            cc.lineTo(nxtLeft, runY);
            cc.stroke();
          }
          cc.setLineDash([]);
          cc.restore();
        }
      };
      charts['c-nopat-bridge'] = new Chart(ctx, {
        type: 'bar',
        data: { labels: labels, datasets: [{
          label: 'USD M', data: floatBars,
          backgroundColor: colors, borderColor: colors, borderWidth: 0, borderRadius: 2,
          barPercentage: 0.6, categoryPercentage: 0.85,
        }]},
        options: {
          responsive: true, maintainAspectRatio: true,
          layout: { padding: { top: 24, right: 8, left: 8, bottom: 8 } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx2 => {
              const s = steps[ctx2.dataIndex];
              return ` ${s.label}: ${sym()}${fmt(s.v)}M`;
            }}}
          },
          scales: {
            x: { ticks: { font:{size:9}, color:'#606060', maxRotation:25, minRotation:15 }, grid: { display:false } },
            y: { ticks: { font:{size:10}, color:'#8a9098',
                  callback: v => `${sym()}${v>=1000?(v/1000).toFixed(1)+'K':v}` },
                  grid: { color:'rgba(27,38,66,0.05)' }, beginAtZero: true }
          }
        },
        plugins: [waterfallLabels]
      });
    }

    const sStart = steps.find(s=>s.kind==='start');
    const sSm    = steps.find(s=>/S&M/.test(s.label));
    const sNr    = steps.find(s=>/Non-Recurring/i.test(s.label));
    const sPre   = steps.find(s=>s.kind==='subtotal');
    const sTax   = steps.find(s=>s.kind==='sub');
    const sEnd   = steps.find(s=>s.kind==='end');
    setEl('adj-headline-nopat', sEnd ? M(sEnd.v) : M(adj.nopatFinal));
    setEl('adj-h-gaap',  sStart ? M(sStart.v) : M(adj.gaapOI));
    setEl('adj-h-sm',    sSm    ? '+' + M(sSm.v) : '—');
    setEl('adj-h-nr',    sNr    ? '+' + M(sNr.v) : '—');
    setEl('adj-h-pre',   sPre   ? M(sPre.v) : '—');
    setEl('adj-h-tax',   sTax   ? M(Math.abs(sTax.v)) : '—');
    setEl('adj-h-nopat', sEnd   ? M(sEnd.v) : M(adj.nopatFinal));
    setEl('adj-hero-caption',
      `GAAP OI of ${M(adj.gaapOI)} understates economic earnings by ${sSm?M(sSm.v):'—'} in S&M growth investment and ${sNr?M(sNr.v):'—'} in non-recurring impairment; applying the ${Pct(adj.taxRate)} normalized tax rate yields ${M(sEnd?sEnd.v:adj.nopatFinal)} of Adjusted NOPAT — the EPV input.`);
  } else {
    setEl('adj-headline-nopat', M(adj.nopatFinal));
  }

  /* ---------- 3. Parameters cards (Bloque 2) ---------- */
  setEl('adj-sm-total',     M(adj.mktTotal));
  setEl('adj-sm-avg',       adj.mkt3yrAvg != null ? M(adj.mkt3yrAvg) : '—');
  setEl('adj-sm-life',      adj.smLife != null ? `${adj.smLife} yrs` : '—');
  setEl('adj-sm-growth',    adj.smGrowthExp != null ? '+' + M(adj.smGrowthExp) : '—');
  setEl('adj-sm-growth-pct',adj.smGrowthPct != null ? Pct(adj.smGrowthPct) : '—');
  setEl('adj-sm-asset',     adj.smAsset != null ? M(adj.smAsset) : '—');

  const rdCapitalized = (adj.rdAsset != null) && (adj.rdLife != null);
  setEl('adj-rd-status', rdCapitalized ? `YES — ${M(adj.rdAsset)} capitalized` : 'NOT APPLIED');
  setEl('adj-rd-life',   adj.rdLife != null ? `${adj.rdLife} yrs` : '—');
  setEl('adj-rd-growth', adj.rdGrowthExp != null ? '+' + M(adj.rdGrowthExp) : '—');
  setEl('adj-rd-asset',  adj.rdAsset != null ? M(adj.rdAsset) : '—');
  if (!rdCapitalized) {
    setEl('adj-rd-note',
      `R&D is <strong>not capitalized</strong> for this company. Rationale: revenue durability is driven primarily by brand and customer loyalty rather than a cumulative R&D knowledge stock; reported R&D (if any) is treated as a recurring opex item. Capitalization is reserved for businesses where the intellectual asset is the principal source of competitive advantage.`);
  }

  setEl('adj-nr-total',    adj.nrTotal != null ? M(adj.nrTotal) : '—');
  setEl('adj-nr-type',     adj.impairment > 0 ? 'Impairment' : (adj.nrTotal > 0 ? 'Mixed' : 'None'));
  setEl('adj-tax-rate',    Pct(adj.taxRate));
  setEl('adj-tax-median',  etrMedian != null ? Pct(etrMedian) : '—');
  setEl('adj-nopat-final', M(adj.nopatFinal));

  /* ---------- 4. S&M Cohort Matrix (Bloque 3) ---------- */
  const cohortEl = document.getElementById('adj-sm-cohort');
  if (cohortEl && cohort && cohort.rows) {
    let h = `<table class="fin-tbl"><thead><tr><th>Cohort \\ Year</th>${cohort.amortYears.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
    cohort.rows.forEach(r => {
      h += `<tr class="norm-row"><td class="row-lbl">${r.cohort}</td>`;
      r.row.forEach(v => { h += `<td class="num-cell">${v==null?'<span style="color:#cfc8bf">·</span>':fmt(v)}</td>`; });
      h += '</tr>';
    });
    h += `<tr class="tot-row"><td class="row-lbl">Economic Amortization (Total)</td>`;
    cohort.totalRow.forEach(v => { h += `<td class="num-cell">${fmt(v)}</td>`; });
    h += '</tr>';
    if (smGrowthHist.length) {
      const aligned = cohort.amortYears.map(ay => {
        const idx = etrYears.indexOf(ay);
        return idx >= 0 ? smGrowthHist[idx] : null;
      });
      h += `<tr class="mrg-row"><td class="row-lbl">S&amp;M Growth Add-back (Marketing − 3yr Avg)</td>`;
      aligned.forEach(v => { h += `<td class="num-cell">${v==null?'—':'+'+fmt(v)}</td>`; });
      h += '</tr>';
    }
    h += '</tbody></table>';
    cohortEl.innerHTML = h;
    setEl('adj-cm-life', adj.smLife || '—');
  } else if (cohortEl) {
    cohortEl.innerHTML = '<div class="csub" style="padding:20px;text-align:center;color:var(--gray-mid)">Cohort matrix not available for this company.</div>';
  }

  /* ---------- 5. Extended NOPAT Build-up Table (Bloque 4) ---------- */
  const nopatEl = document.getElementById('adj-nopat-table');
  if (nopatEl && nopatHist.length) {
    const yrs = nopatHist.map(h => h.year);
    const get = key => nopatHist.map(h => h[key]);
    let h = `<table class="fin-tbl"><thead><tr><th>Step</th>${yrs.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
    const lines = [
      { l: 'Reported GAAP Operating Income', v: get('gaap_oi') },
      { l: '(+) S&amp;M Growth Expense Add-back', v: get('sm_growth'), cls: 'green' },
      { l: '(+) Non-Recurring Items', v: get('nr'), cls: 'green' },
      { l: 'Pre-Tax Adjusted Operating Income', v: get('pre_tax'), sub: true },
      { l: `(×) (1 − Tax ${Pct(adj.taxRate)})`, v: nopatHist.map(hh => Math.round((hh.pre_tax - hh.after_tax) * 10) / 10), dim: true },
      { l: 'Adjusted NOPAT (DCE)', v: get('after_tax'), bold: true },
    ];
    lines.forEach(r => {
      const cls = r.bold ? 'tot-row' : (r.sub ? 'sub-row' : 'norm-row');
      h += `<tr class="${cls}"><td class="row-lbl">${r.l}</td>`;
      r.v.forEach(v => {
        const display = v==null ? '—' : (r.dim ? `(${fmt(Math.abs(v))})` : (r.cls==='green' && v>0 ? `+${fmt(v)}` : fmt(v)));
        h += `<td class="num-cell ${r.dim?'dim':''} ${r.cls||''}">${display}</td>`;
      });
      h += '</tr>';
    });
    h += '</tbody></table>';
    nopatEl.innerHTML = h;
  } else if (nopatEl) {
    const smAdj = isRows.find(r => /S&M Growth/.test(r.l));
    const nrAdj = isRows.find(r => /Normalization/.test(r.l));
    let h = `<table class="fin-tbl"><thead><tr><th>Step</th>${years.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
    const lines = [
      { l: 'Reported GAAP Operating Income', v: fin.operIncome },
      smAdj ? { l: '(+) S&amp;M Growth Expense', v: smAdj.v, cls: 'green' } : null,
      nrAdj ? { l: '(+) Non-Recurring Normalization', v: nrAdj.v, cls: 'green' } : null,
      { l: 'Adjusted NOPAT (DCE)', v: fin.nopatAdjusted, bold: true },
    ].filter(Boolean);
    lines.forEach(r => {
      const cls = r.bold ? 'tot-row' : 'norm-row';
      h += `<tr class="${cls}"><td class="row-lbl">${r.l}</td>`;
      (r.v||[]).forEach(v => { h += `<td class="num-cell ${r.cls||''}">${v==null?'—':fmt(v)}</td>`; });
      h += '</tr>';
    });
    h += '</tbody></table>';
    nopatEl.innerHTML = h;
  }

  /* ---------- 6. GAAP OI vs Adjusted NOPAT chart (Bloque 5) ---------- */
  destroyChart('c-gaap-nopat');
  const gnCtx = document.getElementById('c-gaap-nopat');
  if (gnCtx && fin.operIncome && fin.nopatAdjusted) {
    charts['c-gaap-nopat'] = new Chart(gnCtx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          { label: 'GAAP Operating Income', data: fin.operIncome, borderColor:'#9B2335', backgroundColor:'rgba(155,35,53,0.08)', tension:0.3, fill:false, borderWidth:2, pointRadius:3 },
          { label: 'Adjusted NOPAT (DCE)',  data: fin.nopatAdjusted, borderColor:'#B88B47', backgroundColor:'rgba(184,139,71,0.15)', tension:0.3, fill:true, borderWidth:2.5, pointRadius:3 },
        ]
      },
      options: chartOpts(`${sym()}M`, 'Reported OI vs. Adjusted NOPAT')
    });
  }

  /* ---------- 7. ETR Chart (Bloque 6 — fixed) ---------- */
  destroyChart('c-etr');
  const etrCtx = document.getElementById('c-etr');
  if (etrCtx && etrHist.length) {
    charts['c-etr'] = new Chart(etrCtx, {
      type:'line',
      data:{ labels: etrYears,
        datasets:[
          { label:'ETR %', data: etrHist, borderColor:'#B88B47', backgroundColor:'rgba(184,139,71,0.12)', tension:0.3, fill:true, borderWidth:2, pointRadius:3 },
          { label:`Normalized (${Pct(adj.taxRate)})`, data: etrYears.map(()=>adj.taxRate), borderColor:'#1B2642', borderDash:[6,4], borderWidth:1.5, pointRadius:0, fill:false },
        ]
      },
      options: chartOpts('%','Effective Tax Rate History (%)')
    });
  }

  /* ---------- 8. Sensitivity Panel (Bloque 7) ---------- */
  initAdjSensitivity(adj, fin, etrMedian);
}

/* Sensitivity Panel — interactive sliders */
function initAdjSensitivity(adj, fin, etrMedian) {
  const smLife0 = adj.smLife || 3;
  const rdLife0 = adj.rdLife || 0;
  const tax0    = adj.taxRate || 28;
  const gaap    = adj.gaapOI || 0;
  const nrTot   = adj.nrTotal || 0;
  const published = adj.nopatFinal;
  const mktHistFull = adj.mktHistoryFull;

  const smLifeEl = document.getElementById('sens-sm-life');
  const rdLifeEl = document.getElementById('sens-rd-life');
  const taxEl    = document.getElementById('sens-tax');
  if (!smLifeEl || !rdLifeEl || !taxEl) return;
  smLifeEl.value = smLife0;
  rdLifeEl.value = rdLife0;
  taxEl.value    = tax0;
  document.getElementById('sens-sm-life-val').textContent = smLife0;
  document.getElementById('sens-rd-life-val').textContent = rdLife0 || '—';
  document.getElementById('sens-tax-val').textContent     = tax0;

  function recompute() {
    const L  = parseInt(smLifeEl.value, 10);
    const Lr = parseInt(rdLifeEl.value, 10);
    const t  = parseInt(taxEl.value, 10);
    document.getElementById('sens-sm-life-val').textContent = L;
    document.getElementById('sens-rd-life-val').textContent = Lr || '—';
    document.getElementById('sens-tax-val').textContent     = t;
    let smGrowth = adj.smGrowthExp || 0;
    if (mktHistFull && mktHistFull.length >= L) {
      const last = mktHistFull[mktHistFull.length - 1];
      const window = mktHistFull.slice(-L);
      const avg = window.reduce((a,b)=>a+b,0) / L;
      smGrowth = last - avg;
    }
    const rdGrowth = Lr > 0 ? (adj.rdGrowthExp || 0) : 0;
    const pre = gaap + smGrowth + rdGrowth + nrTot;
    const nopat = pre * (1 - t/100);
    setEl('sens-gaap', M(gaap));
    setEl('sens-pre',  M(Math.round(pre)));
    setEl('sens-nopat',M(Math.round(nopat)));
    const delta = published ? (nopat - published) : 0;
    const pct = published ? (delta / published * 100) : 0;
    const sign = delta >= 0 ? '+' : '−';
    document.getElementById('sens-delta').innerHTML =
      `Δ vs published <strong>${M(published)}</strong>: <strong style="color:${delta>=0?'var(--green)':'var(--red)'}">${sign}${sym()}${fmt(Math.abs(Math.round(delta)))}M</strong> (${sign}${Math.abs(pct).toFixed(1)}%) · S&amp;M growth recalc: ${sym()}${fmt(Math.round(smGrowth))}M @ L=${L}yr`;
  }
  smLifeEl.oninput = recompute;
  rdLifeEl.oninput = recompute;
  taxEl.oninput    = recompute;
  recompute();
}

/* ════════════════════════════════════════════════════════════
   4. REPRODUCTION VALUE
   ════════════════════════════════════════════════════════════ */
function renderRV() {
  buildRVTable('rv-tangible',    D.rv.tangibleAssets,   'Subtotal Tangibles');
  buildRVTable('rv-intangible',  D.rv.intangibleAssets, 'Subtotal Intangibles (Reproduction)');
  buildRVTable('rv-other',       D.rv.otherAssets,      'Subtotal Other Assets');
  buildRVLiabilities();
  updateRVTotals();
  setEl('rv-note', D.rv.note || '');
}

function buildRVTable(containerId, assets, subtotalLabel) {
  const el = document.getElementById(containerId);
  if (!el || !assets) return;
  let html = `<table class="fin-tbl rv-tbl">
    <thead><tr><th>Asset</th><th>Book Value</th><th>Adj %</th><th>Repro Value</th><th>Method</th></tr></thead><tbody>`;
  let subBook = 0, subRepro = 0;
  let anyBook = false;
  assets.forEach((a, i) => {
    const adj = a.defaultAdj;
    const repro = a.bookValue != null ? Math.round(a.bookValue * adj / 100) : (a.reproValue != null ? a.reproValue : 0);
    if (a.bookValue != null) { subBook += a.bookValue; anyBook = true; }
    subRepro += repro;
    const bookCell = a.bookValue != null
      ? `${sym()}${fmt(a.bookValue)}M`
      : `<span style="color:var(--gray-mid)">N/A</span>`;
    const adjCell = a.adjustable === false
      ? `<span class="dim" style="font-size:11px">—</span>`
      : `<input type="number" min="0" max="200" value="${adj}"
          style="width:58px;border:1px solid #e6e6e6;padding:2px 4px;font-family:inherit;font-size:12px;text-align:right;background:#faf8f4"
          onchange="onRVAdj(this,'${containerId}',${i})"
        />%`;
    html += `<tr data-rv-cat="${containerId}" data-rv-idx="${i}">
      <td class="row-lbl">${a.label}${a.estimated ? ' <span class="badge bo">EST</span>' : ''}</td>
      <td class="num-cell">${bookCell}</td>
      <td class="num-cell">${adjCell}</td>
      <td class="num-cell fw" id="rv-val-${containerId}-${i}">${sym()}${fmt(repro)}M</td>
      <td class="num-cell dim" style="font-size:11px">${a.method}</td>
    </tr>`;
  });
  // Subtotal row by category
  if (subtotalLabel) {
    html += `<tr class="sub-row" id="rv-sub-${containerId}">
      <td class="row-lbl">${subtotalLabel}</td>
      <td class="num-cell">${anyBook ? sym()+fmt(subBook)+'M' : '—'}</td>
      <td></td>
      <td class="num-cell fw">${sym()}${fmt(subRepro)}M</td>
      <td></td>
    </tr>`;
  }
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
  function sumRepro(arr) {
    return (arr||[]).reduce((s,a) => {
      const bv = a.bookValue;
      const adj = a.defaultAdj;
      const repro = bv != null ? Math.round(bv * adj / 100) : (a.reproValue != null ? a.reproValue : 0);
      return s + repro;
    }, 0);
  }
  function sumBook(arr) {
    return (arr||[]).reduce((s,a) => s + (a.bookValue != null ? a.bookValue : 0), 0);
  }
  // Repro
  const tang  = sumRepro(D.rv.tangibleAssets);
  const intan = sumRepro(D.rv.intangibleAssets);
  const other = sumRepro(D.rv.otherAssets);
  const total = tang + intan + other;
  // Book
  const tangBook  = sumBook(D.rv.tangibleAssets);
  const intanBook = sumBook(D.rv.intangibleAssets);
  const otherBook = sumBook(D.rv.otherAssets);
  const totalBook = tangBook + intanBook + otherBook;

  const liab    = D.rv.totalLiabilities;
  const equity  = total - liab;
  const equityBook = totalBook - liab;
  const shares  = D.overview.shares > 0 ? D.overview.shares : 1;
  const perShare = equity / shares;
  const perShareBook = equityBook / shares;

  // Update inline subtotals (in case adj % changed)
  function refreshSub(containerId, arr) {
    const subRow = document.getElementById(`rv-sub-${containerId}`);
    if (!subRow) return;
    let bk = 0, rp = 0, anyBook=false;
    arr.forEach(a => {
      const adj = a.defaultAdj;
      const repro = a.bookValue != null ? Math.round(a.bookValue * adj / 100) : (a.reproValue != null ? a.reproValue : 0);
      if (a.bookValue != null) { bk += a.bookValue; anyBook = true; }
      rp += repro;
    });
    const tds = subRow.querySelectorAll('td');
    tds[1].innerHTML = anyBook ? sym()+fmt(bk)+'M' : '—';
    tds[3].innerHTML = sym()+fmt(rp)+'M';
  }
  refreshSub('rv-tangible', D.rv.tangibleAssets);
  refreshSub('rv-intangible', D.rv.intangibleAssets);
  refreshSub('rv-other', D.rv.otherAssets);

  // Asset Summary card (Book vs Repro side by side)
  setEl('rv-sum-tang-book',  M(tangBook));   setEl('rv-sum-tang-repro',  M(tang));
  setEl('rv-sum-intan-book', anyBookIntan(D.rv.intangibleAssets) ? M(intanBook) : '—');
  setEl('rv-sum-intan-repro', M(intan));
  setEl('rv-sum-other-book', M(otherBook));  setEl('rv-sum-other-repro', M(other));
  setEl('rv-sum-total-book', M(totalBook));  setEl('rv-sum-total-repro', M(total));

  // Reproduction Value Build-up card
  setEl('rv-bu-assets-book',  M(totalBook));   setEl('rv-bu-assets-repro',  M(total));
  setEl('rv-bu-liab-book',    `(${M(liab)})`); setEl('rv-bu-liab-repro',    `(${M(liab)})`);
  setEl('rv-bu-equity-book',  M(equityBook));  setEl('rv-bu-equity-repro',  M(equity));
  setEl('rv-bu-shares',       fmtDec(shares, 2) + ' M');
  setEl('rv-bu-pershare-book',fmtPrice(perShareBook));
  setEl('rv-bu-pershare-repro',fmtPrice(perShare));

  // Headline equity
  setEl('rv-equity',      M(equity));
  setEl('rv-per-share',   fmtPrice(perShare));

  // Moat test
  const epvPs = D.epv.epvPerShare;
  const ratio  = epvPs / perShare;
  const moatColor = ratio >= 1.5 ? 'var(--green)' : ratio >= 1 ? 'var(--gold)' : 'var(--red)';
  setEl('rv-moat-ratio', `<span style="color:${moatColor}">${fmtDec(ratio,2)}×</span>`);
  setEl('rv-moat-label', ratio >= 1.5 ? 'Strong Moat' : ratio >= 1.0 ? 'Some Moat' : 'Questionable');
}

function anyBookIntan(arr) {
  return (arr||[]).some(a => a.bookValue != null);
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
      const statusCls = m.status === 'pass' ? 'pass' : m.status === 'fail' ? 'fail' : 'monitor';
      const statusLbl = m.status === 'pass' ? '✓ PASS' : m.status === 'fail' ? '✗ FAIL' : '≈ MONITOR';
      // v4.2: si vienen los 3 umbrales, los mostramos compactos en la columna Threshold
      // resaltando el del estado actual; si no, fallback a m.threshold legacy.
      let thresholdCell;
      if (m.passThreshold || m.monitorThreshold || m.failThreshold) {
        const p = m.passThreshold    || '—';
        const w = m.monitorThreshold || '—';
        const f = m.failThreshold    || '—';
        const hi = (s) => s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'monitor';
        const wrap = (val, s) => m.status === s
          ? `<strong class="${hi(s)}">${val}</strong>`
          : `<span class="dim">${val}</span>`;
        thresholdCell = `<span style="font-size:11px;line-height:1.4">`
          + `${wrap(p, 'pass')} · ${wrap(w, 'monitor')} · ${wrap(f, 'fail')}`
          + `</span>`;
      } else {
        thresholdCell = m.threshold || '';
      }
      html += `<tr>
        <td>${m.label}</td>
        <td class="num-cell">${m.value}</td>
        <td class="num-cell">${thresholdCell}</td>
        <td><span class="${statusCls}">${statusLbl}</span></td>
        <td class="dim">${m.rationale || ''}</td>
      </tr>`;
    });
    el.innerHTML = html;
  }

  // radar chart — labels derived from Health Check categories (converter v2.2)
  // Point color reflects axis status: PASS-tier (≥ 90) gold, MONITOR-tier (60–89) amber, FAIL-tier (<60) red.
  destroyChart('c-radar');
  const rc = document.getElementById('c-radar');
  if (rc && hc.radarLabels && hc.radarScores && hc.radarLabels.length === hc.radarScores.length) {
    const pointColor = (s) => s >= 90 ? '#b88b47' : s >= 60 ? '#d4a259' : '#9b2335';
    charts['c-radar'] = new Chart(rc, {
      type: 'radar',
      data: {
        // Chart.js radar requires labels as arrays of strings for multi-line.
        // Support both literal '\\n' (escaped, from JSON) and real '\n' (from Supabase jsonb).
        labels: hc.radarLabels.map(l => {
          const s = String(l).replace(/\\n/g, '\n');
          return s.includes('\n') ? s.split('\n') : s;
        }),
        datasets: [{
          label: D.ticker,
          data: hc.radarScores,
          borderColor: '#b88b47',
          backgroundColor: 'rgba(184,139,71,0.15)',
          pointBackgroundColor: hc.radarScores.map(pointColor),
          pointBorderColor: hc.radarScores.map(pointColor),
          pointRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 8, bottom: 8, left: 12, right: 12 } },
        scales: { r: {
          beginAtZero: true, max: 100,
          ticks: { font: {size: 10}, color: '#8a9098', stepSize: 25, backdropColor: 'transparent' },
          pointLabels: { font: {size: 12, weight: '500'}, color: '#1b2642' },
          grid: { color: 'rgba(27,38,66,0.08)' },
          angleLines: { color: 'rgba(27,38,66,0.08)' },
        }},
        elements: { line: { borderWidth: 2 }, point: { radius: 5, hoverRadius: 7 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.r;
                const tier = v >= 90 ? 'PASS' : v >= 60 ? 'MONITOR' : 'FAIL';
                return `${v} / 100 (${tier})`;
              }
            }
          }
        }
      }
    });
  }
}

/* ════════════════════════════════════════════════════════════
   8b. THESIS HEALTH (Tier-1 KPI tracker · IPS §4.7)
   ════════════════════════════════════════════════════════════ */
async function renderThesis() {
  const grid    = document.getElementById('th-grid');
  const meta    = document.getElementById('th-meta');
  const status  = document.getElementById('th-status');
  const empty   = document.getElementById('th-empty');
  if (!grid) return;

  // Reset
  grid.innerHTML = '';
  meta.innerHTML = '';
  status.innerHTML = '';
  empty.style.display = 'none';
  grid.style.display = '';

  const ticker = (D && D.ticker) ? D.ticker.toLowerCase() : '';
  if (!ticker) return;

  let mon;
  try {
    const res = await fetch(`/data/monitoring_${ticker}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error('not found');
    mon = await res.json();
  } catch (e) {
    grid.style.display = 'none';
    empty.style.display = '';
    empty.innerHTML = `<strong>No thesis health data available for ${(D.ticker||'').toUpperCase()}.</strong><br>
      Once the Investment Memo is published, the Tier-1 KPIs (per IPS §4.7) will appear here and update each quarter via the re-underwriting workflow.`;
    return;
  }

  // Meta row
  const q       = mon.q1_2026_status_quarter || mon._meta?.last_modified || '—';
  const updated = mon._meta?.last_modified || '—';
  meta.innerHTML = `As of <strong>${q}</strong> · Updated ${updated} · ${mon.classification || ''} · IPS §4.7`;

  // Status banner
  const banner = (mon.q1_2026_status || 'PENDING').toLowerCase();
  const bannerLabel = {
    green:  'Thesis intact',
    amber:  'Watch — thresholds drifting',
    red:    'Thesis at risk',
    pending:'Awaiting first update'
  }[banner] || 'Pending';
  status.className = 'th-status-banner ' + banner;
  status.innerHTML = `<span class="th-dot"></span>
    <div class="th-status-text"><strong>${bannerLabel}.</strong> ${mon.q1_2026_status_note || ''}</div>`;

  // KPI cards
  const metrics = mon.tier_1_metrics || [];
  if (!metrics.length) {
    grid.innerHTML = '<div class="th-empty">No Tier-1 metrics defined.</div>';
    return;
  }

  const cards = metrics.map(m => buildThesisCard(m));
  grid.innerHTML = cards.join('');
}

function thesisStatusOf(m) {
  if (m.current_value == null || m.current_value === undefined) return 'pending';
  if (m.current_status) return String(m.current_status).toLowerCase();
  const v = Number(m.current_value);
  const dir = m.direction || 'higher_is_better';
  const yt = m.yellow_threshold, rt = m.red_threshold;
  if (dir === 'higher_is_better') {
    if (rt != null && v < rt) return 'red';
    if (yt != null && v < yt) return 'amber';
    return 'green';
  } else {
    if (rt != null && v > rt) return 'red';
    if (yt != null && v > yt) return 'amber';
    return 'green';
  }
}

function buildThesisCard(m) {
  const st = thesisStatusOf(m);
  const pillLabel = { green:'On track', amber:'Watch', red:'Breach', pending:'Pending' }[st] || 'Pending';
  const sparkColor = { green:'#15803d', amber:'#b45309', red:'#b91c1c', pending:'#71717a' }[st];

  // Value block
  let valueBlock;
  if (m.current_value == null) {
    valueBlock = `<div class="th-value-row"><div class="th-value pending">Awaiting first update</div></div>`;
  } else {
    const v = Number(m.current_value);
    const unit = m.unit === 'ratio' ? 'x' : (m.unit || '');
    const display = (Math.abs(v) < 10 && !Number.isInteger(v)) ? v.toFixed(2) : v.toFixed(1);
    let trendHTML = '';
    if (Array.isArray(m.history) && m.history.length >= 2) {
      const prev = Number(m.history[m.history.length - 2].value);
      const cur  = Number(m.history[m.history.length - 1].value);
      const delta = cur - prev;
      const absD = Math.abs(delta);
      const sym = delta > 0.0001 ? '↑' : (delta < -0.0001 ? '↓' : '→');
      const cls = (m.direction === 'higher_is_better')
        ? (delta > 0.0001 ? 'up' : (delta < -0.0001 ? 'down' : 'flat'))
        : (delta > 0.0001 ? 'down' : (delta < -0.0001 ? 'up' : 'flat'));
      let label;
      if (absD < 0.01) label = '→';
      else if (m.unit === '%') label = `${sym} ${absD.toFixed(1)}pp`;
      else if (m.unit === 'ratio' || m.unit === 'x') label = `${sym} ${absD.toFixed(2)}x`;
      else label = `${sym} ${absD.toFixed(2)}`;
      trendHTML = `<div class="th-trend ${cls}">${label}</div>`;
    }
    valueBlock = `<div class="th-value-row">
      <div class="th-value">${display}</div>
      <div class="th-unit">${unit}</div>
      ${trendHTML}
    </div>`;
  }

  // Target line
  const unitTxt = m.unit === 'ratio' ? 'x' : (m.unit || '');
  let targetLine;
  if (Array.isArray(m.expected_range) && m.expected_range.length === 2) {
    const [a, b] = m.expected_range;
    const fmt = (x) => (Math.abs(x) < 10 && !Number.isInteger(x)) ? Number(x).toFixed(2) : Number(x).toFixed(0);
    if (m.direction === 'higher_is_better') {
      targetLine = `Target <strong>${fmt(a)}–${fmt(b)}${unitTxt}</strong>`;
      if (m.yellow_threshold != null) targetLine += ` · Yellow <strong>&lt; ${fmt(m.yellow_threshold)}${unitTxt}</strong>`;
      if (m.red_threshold != null)    targetLine += ` · Red <strong>&lt; ${fmt(m.red_threshold)}${unitTxt}</strong>`;
    } else {
      targetLine = `Target <strong>${fmt(a)}–${fmt(b)}${unitTxt}</strong>`;
      if (m.yellow_threshold != null) targetLine += ` · Yellow <strong>&gt; ${fmt(m.yellow_threshold)}${unitTxt}</strong>`;
      if (m.red_threshold != null)    targetLine += ` · Red <strong>&gt; ${fmt(m.red_threshold)}${unitTxt}</strong>`;
    }
  } else {
    targetLine = '';
  }

  // Sparkline
  let sparkSVG = '';
  if (Array.isArray(m.history) && m.history.length >= 2) {
    const vals = m.history.map(h => Number(h.value));
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const W = 200, H = 36, pad = 4;
    const pts = vals.map((v, i) => {
      const x = (vals.length === 1) ? W/2 : (i / (vals.length - 1)) * W;
      const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = pts.split(' ').slice(-1)[0].split(',');
    sparkSVG = `<svg class="th-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline fill="none" stroke="${sparkColor}" stroke-width="1.6" points="${pts}"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="${sparkColor}"/>
    </svg>`;
  }

  return `<div class="th-card ${st}">
    <div class="th-row-top">
      <div class="th-name">${m.name || m.id}</div>
      <span class="th-pill">${pillLabel}</span>
    </div>
    ${valueBlock}
    <div class="th-target">${targetLine}</div>
    ${sparkSVG}
    <div class="th-thesis"><em>Thesis link.</em> ${m.thesis_link || ''}</div>
    <div class="th-source">Source · ${m.data_source || '—'}</div>
  </div>`;
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

  // Key Model Inputs (moved from Overview tab)
  const adj = D.adj;
  const irr = D.irr;
  const cio = D.cioDecisions;
  const cioVal = (id) => { const r = cio.find(c=>c.id===id); return r ? r.value : '—'; };
  setEl('ov-inputs-nopat',    M(D.epv.nopatBase));
  setEl('ov-inputs-revenue',  M(ov.revenue));
  setEl('ov-inputs-margin',   Pct(ov.operMargin*100));
  setEl('ov-inputs-tax',      Pct(ov.taxRate*100));
  setEl('ov-inputs-wacc',     Pct(ov.wacc*100));
  setEl('ov-inputs-shares',   fmt(ov.shares));
  setEl('ov-irr-roic',     Pct(irr.selectedRoic));
  setEl('ov-irr-organic',  Pct(irr.organicGrowth));
  setEl('ov-irr-reinvg',   Pct(irr.reinvGrowth));
  setEl('ov-irr-exit',     `${irr.exitMultiple}× EV/NOPAT`);
  setEl('ov-irr-buybacks', M(irr.buybacks));
  setEl('ov-irr-horizon',  `${irr.horizon} years`);
  setEl('ov-cap-sm',     cioVal('DP3') + (adj.smLife ? ` (${adj.smLife}yr)` : ''));
  setEl('ov-cap-rd',     cioVal('DP2'));
  setEl('ov-cap-sbc',    cioVal('DP5'));
  setEl('ov-cap-window', cioVal('DP6'));
  setEl('ov-cap-norm',   cioVal('DP7'));
  setEl('ov-cap-gw',     cioVal('DP12'));

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

  // Stage thesis prefill (used by /journal modal when action=new). Stored in
  // sessionStorage to avoid URL length / encoding issues with multi-paragraph text.
  // Click handler refreshes the staged value at navigation time.
  btn.onclick = () => {
    if (btn.getAttribute('data-mode') !== 'new') return; // view mode — no prefill
    try {
      const ts = (D && D.thesisSummary) || {};
      const narrative = String(ts.narrative || '').trim();
      const ov = (D && D.overview) || {};
      const epv = (D && D.epv) || {};
      const moS = ts.marginOfSafety;
      const irr = ts.impliedIrr;
      const peRatio = ts.priceEpvRatio;
      const stamp = [];
      if (Number.isFinite(moS))     stamp.push(`MoS ${moS>=0?'+':''}${(moS*100).toFixed(1)}%`);
      if (Number.isFinite(irr))     stamp.push(`IRR ${(irr*100).toFixed(1)}% (hurdle ${(D.irr.hurdle*100).toFixed(1)}%)`);
      if (Number.isFinite(peRatio)) stamp.push(`Price/EPV ${peRatio.toFixed(2)}x`);
      const header = stamp.length ? `[Columbia snapshot @ ${D.valuationDate || 'today'}] ${stamp.join(' · ')}` : '';
      const body = [header, narrative].filter(Boolean).join('\n\n');
      if (body) {
        sessionStorage.setItem('dce_journal_prefill', JSON.stringify({
          ticker: ticker,
          thesis: body,
          stamped_at: Date.now()
        }));
      }
    } catch (_) { /* non-blocking */ }
  };

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
