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
    {id:'sales',       label:'Revenue', salesGuard: true},
    {id:'audit',       label:'CIO Decisions'},
    {id:'adj',         label:'Adjustments'},
    {id:'rv',          label:'Reproduction Value'},
    {id:'epv',         label:'EPV'},
    {id:'roic',        label:'ROIC and Capital'},
    {id:'irr',         label:'Implied IRR'},
    {id:'thesis',      label:'Thesis Health'},
    {id:'vr',          label:'Company Brief',   external: D.documents.valuationReportUrl, style:'color:var(--gold);font-weight:600'},
    {id:'tb',          label:'Thesis Breaker',    external: D.documents.thesisBreakerUrl,  style:'color:var(--red);font-weight:600'},
    {id:'tbld',        label:'Thesis Builder',    external: D.documents.thesisBuilderUrl,  style:'color:var(--green);font-weight:600'},
    {id:'munger',      label:'Munger Digital',    external: D.documents.mungerDigitalUrl,  style:'color:#6b4fa0;font-weight:600'},
    {id:'summary',     label:'Summary'},
    {id:'home',        label:'← Home', home: true, style:'margin-left:auto;color:var(--gray-mid)'},
  ];

  nav.innerHTML = tabs.map(t => {
    if (t.versionSlot) {
      return `<div id="version-selector" style="display:none;align-items:center;gap:8px;padding:0 14px 0 0;margin-right:8px;border-right:1px solid var(--line)"></div>`;
    }
    if (t.salesGuard && (!D.sales || !D.sales.years)) {
      return '';
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
    case 'sales':      renderSales(); break;
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
   2b. SALES — Revenue por segmento, geografía, canal y sourcing
   ════════════════════════════════════════════════════════════ */
function renderSales() {
  const s = D.sales;
  if (!s || !s.years) return;
  const years = s.years;

  // --- 1. Tablas (segment, geo, channel, sourcing) ---
  const buildHistTable = (rows, withComp) => {
    let html = `<table class="fin-tbl"><thead><tr><th>Item</th>${years.map(y=>`<th>${y}</th>`).join('')}<th>% FY25</th>${withComp?'<th>Crecimiento / Comp</th>':''}</tr></thead><tbody>`;
    rows.forEach(r => {
      html += `<tr class="norm-row"><td class="row-lbl">${r.label}</td>`;
      r.values.forEach(v => { html += `<td class="num-cell">${fmt(v)}</td>`; });
      html += `<td class="num-cell fw">${r.pctFY25}%</td>`;
      if (withComp) html += `<td class="num-cell" style="text-align:left;padding-left:14px;font-size:12px;color:var(--gray-mid)">${r.comp || '—'}</td>`;
      html += `</tr>`;
    });
    // Totals row — usar totalRevenue oficial del 10-K (no la suma de estimaciones por segmento)
    const totals = s.totalRevenue && s.totalRevenue.length === years.length
      ? s.totalRevenue
      : years.map((_,i) => rows.reduce((a,r) => a + (r.values[i]||0), 0));
    html += `<tr class="tot-row"><td class="row-lbl">Total Revenue (10-K)</td>`;
    totals.forEach(v => { html += `<td class="num-cell fw">${fmt(v)}</td>`; });
    html += `<td class="num-cell fw">100%</td>`;
    if (withComp) html += `<td></td>`;
    html += `</tr></tbody></table>`;
    return html;
  };

  const buildMixTable = (rows) => {
    let html = `<table class="fin-tbl"><thead><tr><th>Item</th><th>% FY25</th><th style="text-align:left;padding-left:14px">Nota</th></tr></thead><tbody>`;
    rows.forEach(r => {
      html += `<tr class="norm-row"><td class="row-lbl">${r.label}</td><td class="num-cell fw">${r.pctFY25}%</td><td class="num-cell" style="text-align:left;padding-left:14px;font-size:12px;color:var(--gray-mid)">${r.note||'—'}</td></tr>`;
    });
    html += `</tbody></table>`;
    return html;
  };

  setEl('tbl-sales-segment',  buildHistTable(s.bySegment, false));
  setEl('tbl-sales-geo',      buildHistTable(s.byGeography, true));
  setEl('tbl-sales-channel',  buildMixTable(s.byChannel));
  setEl('tbl-sales-sourcing', buildMixTable(s.bySourcing));

  // Override sourcing block label if JSON provides a custom one (e.g. "Mix de Producto" for luxury)
  if (s.sourcingLabel) setTxt('slbl-sales-sourcing', s.sourcingLabel);
  // Override segment/geo block labels if provided (mostly to swap currency in heading text)
  const curM = `(${sym()}M)`;
  setTxt('slbl-sales-segment', `Ventas por Segmento ${curM}`);
  setTxt('slbl-sales-geo',     `Ventas por Geografía ${curM}`);
  setTxt('clbl-sales-seg',     `Revenue por Segmento ${curM}`);
  setTxt('clbl-sales-geo',     `Revenue por Geografía ${curM}`);

  // --- 2. Notas + source ---
  const ul = document.getElementById('sales-notes');
  if (ul) ul.innerHTML = (s.notes || []).map(n => `<li>${n}</li>`).join('');
  setTxt('sales-source', s.source || '');

  // --- 3. Charts (stacked bar segment, stacked bar geo) ---
  destroyChart('c-sales-seg'); destroyChart('c-sales-geo');
  const palette = ['rgba(27,38,66,0.85)', 'rgba(184,139,71,0.85)', 'rgba(42,122,86,0.85)', 'rgba(155,35,53,0.7)', 'rgba(107,79,160,0.75)'];

  const cSeg = document.getElementById('c-sales-seg');
  if (cSeg) charts['c-sales-seg'] = new Chart(cSeg, {
    type:'bar', data:{ labels: years,
      datasets: s.bySegment.map((r,i) => ({ label: r.label, data: r.values, backgroundColor: palette[i % palette.length] }))
    },
    options: { ...chartOpts(`${sym()}M`, `Revenue por Segmento (${sym()}M)`),
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => fmt(v) } } }
    }
  });

  const cGeo = document.getElementById('c-sales-geo');
  if (cGeo) charts['c-sales-geo'] = new Chart(cGeo, {
    type:'bar', data:{ labels: years,
      datasets: s.byGeography.map((r,i) => ({ label: r.label, data: r.values, backgroundColor: palette[i % palette.length] }))
    },
    options: { ...chartOpts(`${sym()}M`, `Revenue por Geografía (${sym()}M)`),
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => fmt(v) } } }
    }
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
  // Normalize legacy format: if item has `value` but no `bookValue`, treat value as bookValue at 100%
  D.rv.liabilities.forEach(l => {
    if (l.bookValue == null && l.value != null) {
      l.bookValue   = l.value;
      l.adjustable  = (l.adjustable !== false);
      l.defaultAdj  = l.defaultAdj != null ? l.defaultAdj : 100;
      l.reproValue  = l.reproValue != null ? l.reproValue : l.value;
    }
  });
  let html = `<table class="fin-tbl rv-tbl">
    <thead><tr><th>Liability</th><th>Book Value</th><th>Adj %</th><th>Repro Value</th><th>Method</th></tr></thead><tbody>`;
  let subBook = 0, subRepro = 0;
  let anyBook = false;
  D.rv.liabilities.forEach((l, i) => {
    const adj = l.defaultAdj != null ? l.defaultAdj : 100;
    const repro = l.bookValue != null ? Math.round(l.bookValue * adj / 100) : (l.reproValue != null ? l.reproValue : 0);
    if (l.bookValue != null) { subBook += l.bookValue; anyBook = true; }
    subRepro += repro;
    const bookCell = l.bookValue != null
      ? `(${sym()}${fmt(l.bookValue)}M)`
      : `<span style="color:var(--gray-mid)">N/A</span>`;
    const adjCell = l.adjustable === false
      ? `<span class="dim" style="font-size:11px">—</span>`
      : `<input type="number" min="0" max="200" value="${adj}"
          style="width:58px;border:1px solid #e6e6e6;padding:2px 4px;font-family:inherit;font-size:12px;text-align:right;background:#faf8f4"
          onchange="onRVLiabAdj(this,${i})"
        />%`;
    html += `<tr data-rv-cat="rv-liabilities" data-rv-idx="${i}">
      <td class="row-lbl">${l.label}</td>
      <td class="num-cell">${bookCell}</td>
      <td class="num-cell">${adjCell}</td>
      <td class="num-cell fw" id="rv-val-rv-liabilities-${i}">(${sym()}${fmt(repro)}M)</td>
      <td class="num-cell dim" style="font-size:11px">${l.method || ''}</td>
    </tr>`;
  });
  html += `<tr class="tot-row" id="rv-sub-rv-liabilities">
    <td class="row-lbl">Total Liabilities</td>
    <td class="num-cell">${anyBook ? '('+sym()+fmt(subBook)+'M)' : '—'}</td>
    <td></td>
    <td class="num-cell fw">(${sym()}${fmt(subRepro)}M)</td>
    <td></td>
  </tr>`;
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

function onRVLiabAdj(inputEl, idx) {
  const newAdj = parseFloat(inputEl.value) || 0;
  const arr = D.rv.liabilities;
  if (!arr || !arr[idx]) return;
  arr[idx].defaultAdj = newAdj;
  const l = arr[idx];
  const newRepro = l.bookValue != null ? Math.round(l.bookValue * newAdj / 100) : (newAdj || 0);
  arr[idx].reproValue = newRepro;
  setEl(`rv-val-rv-liabilities-${idx}`, `(${sym()}${fmt(newRepro)}M)`);
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

  // Liabilities: sum from per-item bookValue × defaultAdj when array exists, fallback to totalLiabilities
  function sumLiabRepro(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((s, l) => {
      const bv = l.bookValue != null ? l.bookValue : l.value;
      const adj = l.defaultAdj != null ? l.defaultAdj : 100;
      const r = bv != null ? Math.round(bv * adj / 100) : (l.reproValue != null ? l.reproValue : 0);
      return s + r;
    }, 0);
  }
  function sumLiabBook(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((s, l) => s + (l.bookValue != null ? l.bookValue : (l.value != null ? l.value : 0)), 0);
  }
  const liabBookFromArr  = sumLiabBook(D.rv.liabilities);
  const liabReproFromArr = sumLiabRepro(D.rv.liabilities);
  const liabBook  = liabBookFromArr  != null ? liabBookFromArr  : D.rv.totalLiabilities;
  const liab      = liabReproFromArr != null ? liabReproFromArr : D.rv.totalLiabilities;
  // Refresh liabilities subtotal row in place
  const liabSubRow = document.getElementById('rv-sub-rv-liabilities');
  if (liabSubRow && liabBookFromArr != null) {
    const tds = liabSubRow.querySelectorAll('td');
    if (tds[1]) tds[1].innerHTML = '('+sym()+fmt(liabBook)+'M)';
    if (tds[3]) tds[3].innerHTML = '('+sym()+fmt(liab)+'M)';
  }
  const equity  = total - liab;
  const equityBook = totalBook - liabBook;
  const shares      = D.overview.shares > 0 ? D.overview.shares : 1;
  // Columbia book uses different share count (historical avg) when provided
  const sharesBook  = (D.rv.sharesBook && D.rv.sharesBook > 0) ? D.rv.sharesBook : shares;
  const perShare = equity / shares;
  const perShareBook = equityBook / sharesBook;

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

  // Reproduction Value Build-up card
  setEl('rv-bu-assets-book',  M(totalBook));   setEl('rv-bu-assets-repro',  M(total));
  setEl('rv-bu-liab-book',    `(${M(liabBook)})`); setEl('rv-bu-liab-repro',    `(${M(liab)})`);
  setEl('rv-bu-equity-book',  M(equityBook));  setEl('rv-bu-equity-repro',  M(equity));
  setEl('rv-bu-shares-book',  fmtDec(sharesBook, 2) + ' M');
  setEl('rv-bu-shares-repro', fmtDec(shares, 2) + ' M');
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
  // Slider ranges
  const nopatMin = Math.round(epv.nopatBase * 0.5);
  const nopatMax = Math.round(epv.nopatBase * 1.8);
  setSlider('sl-nopat', epv.nopatBase, nopatMin, nopatMax, 50);
  setSlider('sl-wacc',  epv.waccBase,  3, 20, 0.1);
  setSlider('sl-tax',   epv.taxBase,   10, 45, 1);
  // Bounds labels
  setEl('sl-nopat-min', `${sym()}${fmt(nopatMin)}M`);
  setEl('sl-nopat-max', `${sym()}${fmt(nopatMax)}M`);
  setEl('sl-wacc-min', '3%');
  setEl('sl-wacc-max', '20%');
  setEl('sl-tax-min', '10%');
  setEl('sl-tax-max', '45%');
  // Footnotes (from Supabase if present)
  const fn = epv.assumptionsFootnotes || {};
  setEl('sl-nopat-note', fn.nopat || '');
  setEl('sl-wacc-note',  fn.wacc  || '');
  setEl('sl-tax-note',   fn.tax   || '');
  // Initial display values
  setEl('sl-nopat-val', `${sym()}${fmt(epv.nopatBase)}M`);
  setEl('sl-wacc-val',  `${fmtDec(epv.waccBase,2)}%`);
  setEl('sl-tax-val',   `${fmtDec(epv.taxBase,0)}%`);

  updateEPVCalc();
  renderEPVBridge();
  renderSensitivity();
  renderWACCComponents();
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
    else if (field === 'wacc') display.textContent = `${fmtDec(parseFloat(val),2)}%`;
    else display.textContent = `${fmtDec(parseFloat(val),0)}%`;
  }
  updateEPVCalc();
  // Sensitivity matrix is static — it shows deviation from base (default) NOPAT × WACC, not from slider state
}

function resetEPVAssumptions() {
  const epv = D.epv;
  epvState = { nopat: epv.nopatBase, wacc: epv.waccBase, tax: epv.taxBase };
  const slN = document.getElementById('sl-nopat'); if (slN) slN.value = epv.nopatBase;
  const slW = document.getElementById('sl-wacc');  if (slW) slW.value = epv.waccBase;
  const slT = document.getElementById('sl-tax');   if (slT) slT.value = epv.taxBase;
  setEl('sl-nopat-val', `${sym()}${fmt(epv.nopatBase)}M`);
  setEl('sl-wacc-val',  `${fmtDec(epv.waccBase,2)}%`);
  setEl('sl-tax-val',   `${fmtDec(epv.taxBase,0)}%`);
  updateEPVCalc();
  renderSensitivity();
}

function renderWACCComponents() {
  const w = D.wacc; if (!w) return;
  setEl('wacc-rf',      Pct(w.rf*100));
  setEl('wacc-beta',    fmtDec(w.beta, 2));
  setEl('wacc-erp',     Pct(w.erp*100));
  // Ke formula breakdown: Rf + β·ERP
  const betaErp = w.beta * w.erp * 100;
  setEl('wacc-ke-formula', `${Pct(w.rf*100)} + ${fmtDec(w.beta,2)}·${Pct(w.erp*100)} = ${Pct(w.rf*100 + betaErp)}`);
  setEl('wacc-ke',      Pct(w.ke*100));
  setEl('wacc-kd-pre',  Pct((w.kdPreTax||0)*100));
  setEl('wacc-kd-post', Pct((w.kdAfterTax||0)*100));
  setEl('wacc-wd',      Pct((w.weightDebt||0)*100));
  setEl('wacc-we',      Pct((w.weightEquity||1)*100));
  setEl('wacc-final',   Pct((w.waccFinal||w.ke)*100));

  // WACC Validation cross-check
  const v = w.validation || {};
  setEl('wacc-val-dce',         Pct((w.waccFinal||w.ke)*100));
  setEl('wacc-val-damodaran',   v.damodaranSector != null ? Pct(v.damodaranSector*100) : 'Pendiente');
  setEl('wacc-val-peers',       v.peerAvg         != null ? Pct(v.peerAvg*100)         : 'Pendiente');
  // Implied cost: NOPAT_base / Price·Shares  → if market priced at EPV, what discount rate would equal it?
  const epv = D.epv;
  const px  = (typeof currentPrice === 'number' && currentPrice > 0) ? currentPrice : (D.overview.stockPrice || 0);
  const shares = D.overview.shares;
  if (epv && px > 0 && shares > 0) {
    const mktEquity = px * shares;
    const mktOps    = mktEquity - (epv.excessCash||0) - (epv.ltInv||0) - (epv.debt||0) - (epv.leases||0) - (epv.minorityInterest||0);
    const implied   = mktOps > 0 ? (epv.nopatBase / mktOps) * 100 : null;
    setEl('wacc-val-implied', implied != null ? Pct(implied) : 'Pendiente');
  } else {
    setEl('wacc-val-implied', 'Pendiente');
  }
}

function updateEPVCalc() {
  const { nopat, wacc, tax } = epvState;
  const epv = D.epv;
  // EPV Ops = NOPAT / WACC (D&A − MaintCapex net zero)
  const epvOps = (nopat / (wacc / 100));
  const epvEq  = epvOps + (epv.excessCash||0) + (epv.ltInv||0) + (epv.debt||0) + (epv.leases||0) + (epv.minorityInterest||0);
  const shares = D.overview.shares;
  const epvPs  = shares > 0 ? epvEq / shares : 0;
  const px     = (typeof currentPrice === 'number' && currentPrice > 0) ? currentPrice : (D.overview.stockPrice || 0);
  const priceEpv = epvPs > 0 ? px / epvPs : 0;
  const priceColor = priceEpv <= 1 ? 'var(--green)' : priceEpv <= 1.5 ? 'var(--gold)' : 'var(--red)';
  const priceLabel = priceEpv <= 1
    ? 'Trading below EPV — margin of safety'
    : priceEpv <= 1.5 ? 'Trading near EPV — fair value' : 'Market paying implied growth premium';

  setEl('epv-ops',    M(Math.round(epvOps)));
  setEl('epv-equity', M(Math.round(epvEq)));
  setEl('epv-ps',     fmtPrice(epvPs));
  setEl('epv-share-sub', `${fmtDec(shares,2)}M diluted shares`);
  setEl('epv-price-ratio', `<span style="color:${priceColor}">${fmtDec(priceEpv,2)}×</span>`);
  setEl('epv-price-label', priceLabel);

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
  const px = (typeof currentPrice === 'number' && currentPrice > 0) ? currentPrice : (D.overview.stockPrice || 0);
  // Build WACC vals around base ±2 pts (5 cols, 1pt step)
  const baseW = epv.waccBase;
  const waccVals = [baseW - 2, baseW - 1, baseW, baseW + 1, baseW + 2].map(v => Math.round(v*10)/10);
  // NOPAT rows: 5 levels, ±20% around base in 10% increments
  const nopatMults = [0.8, 0.9, 1.0, 1.1, 1.2];

  // First pass: compute all ratios + find the base ratio (center cell) for relative coloring
  const grid = [];
  let baseRatio = null;
  nopatMults.forEach((m, i) => {
    const n = epv.nopatBase * m;
    const row = [];
    waccVals.forEach(w => {
      const ops = n / (w/100);
      const eq  = ops + (epv.excessCash||0) + (epv.ltInv||0) + (epv.debt||0) + (epv.leases||0) + (epv.minorityInterest||0);
      const ps  = shares > 0 ? eq / shares : 0;
      const ratio = ps > 0 ? px / ps : 0;
      row.push(ratio);
      if (m === 1.0 && Math.abs(w - baseW) < 0.05) baseRatio = ratio;
    });
    grid.push(row);
  });
  if (!baseRatio) baseRatio = 1.0;  // fallback

  // Coloring: RELATIVE to base case so dispersion is always visible
  //   ratio <= base × 0.85  → strong green  (notably cheaper than base)
  //   ratio <= base × 1.00  → light green   (cheaper or equal to base)
  //   ratio <= base × 1.15  → light gold    (slightly above base)
  //   ratio <= base × 1.40  → gold          (clearly above base)
  //   ratio >  base × 1.40  → red           (premium territory)
  // Plus absolute floor: ratio > 2.0 always red (paying for growth regardless of base)
  const colorFor = (r) => {
    if (r > 2.0) return 'rgba(155,35,53,0.18)';
    const rel = r / baseRatio;
    if (rel <= 0.85) return 'rgba(42,122,86,0.22)';
    if (rel <= 1.00) return 'rgba(42,122,86,0.10)';
    if (rel <= 1.15) return 'rgba(184,139,71,0.10)';
    if (rel <= 1.40) return 'rgba(184,139,71,0.22)';
    return 'rgba(155,35,53,0.18)';
  };

  let html = `<table class="fin-tbl sens-tbl">
    <thead><tr><th>NOPAT \\ WACC</th>${waccVals.map(w=>`<th>${fmtDec(w,1)}%</th>`).join('')}</tr></thead><tbody>`;
  nopatMults.forEach((m, i) => {
    const n = epv.nopatBase * m;
    const nLbl = n >= 1000 ? `${sym()}${fmtDec(n/1000,1)}B` : `${sym()}${fmt(Math.round(n))}M`;
    html += `<tr><th class="row-lbl">${nLbl}</th>`;
    waccVals.forEach((w, j) => {
      const ratio = grid[i][j];
      const isBase = m === 1.0 && Math.abs(w - baseW) < 0.05;
      const bg = colorFor(ratio);
      html += `<td class="num-cell" style="background:${bg};${isBase?'font-weight:700;border:1.5px solid #b88b47':''}">${fmtDec(ratio,2)}×</td>`;
    });
    html += '</tr>';
  });
  html += `</tbody></table>
    <p style="font-size:10px;color:#8a9098;margin-top:8px;padding:4px 8px">
      Legend (relative to base case <strong>${fmtDec(baseRatio,2)}×</strong>):
      <span style="display:inline-block;width:10px;height:10px;background:rgba(42,122,86,0.5);vertical-align:middle;margin:0 4px 0 8px"></span>cheaper than base ·
      <span style="display:inline-block;width:10px;height:10px;background:rgba(184,139,71,0.5);vertical-align:middle;margin:0 4px 0 8px"></span>above base (≤1.4× relative) ·
      <span style="display:inline-block;width:10px;height:10px;background:rgba(155,35,53,0.4);vertical-align:middle;margin:0 4px 0 8px"></span>premium / &gt;2.0× absolute
    </p>`;
  el.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   6. ROIC & CAPITAL
   ════════════════════════════════════════════════════════════ */
function renderROIC() {
  const roic = D.roic;
  const years = D.financials.years;
  const waccPct = D.overview.wacc * 100;
  const N = years.length;
  const latestYr = years[N-1];
  const yr3start = years[N-3];

  // ===== HERO CARDS =====
  setEl('roic-latest-yr', `(${latestYr})`);
  setEl('roic-latest', Pct(roic.roicLatest));
  setEl('roic-latest-sub', `NOPAT ${M(roic.nopatHistory[N-1])} / IC ${M(roic.icHistory[N-1])}`);

  setEl('roic-3yr-range', `(${yr3start}–${latestYr})`);
  setEl('roic-3yr', Pct(roic.roic3yr));
  const last3 = roic.roicHistory.slice(-3);
  setEl('roic-3yr-sub', last3.map((r,i)=>`${years[N-3+i]}: ${fmtDec(r,1)}%`).join(' · '));

  setEl('roic-wacc', Pct(waccPct));
  const w = D.wacc;
  if (w) setEl('roic-wacc-sub', `Rf ${Pct(w.rf*100)} · β ${fmtDec(w.beta,2)} · ERP ${Pct(w.erp*100)}`);
  else setEl('roic-wacc-sub', '—');

  const spread = roic.roicLatest - waccPct;
  setEl('roic-spread', `${spread >= 0 ? '+' : ''}${Pct(spread)}`);
  setEl('roic-spread-sub', spread > 0 ? 'Creates economic value ✓' : 'Destroys economic value ✗');

  // ===== MARGINAL ROIC CARDS =====
  setEl('roic-marginal', Pct(roic.marginalRoic));
  // 1yr deltas
  const dN = roic.nopatHistory[N-1] - roic.nopatHistory[N-2];
  const dIC = roic.icHistory[N-1] - roic.icHistory[N-2];
  setEl('roic-marginal-sub', `ΔNOPAT ${M(dN)} / ΔIC ${M(dIC)}`);

  setEl('roic-gcapex-2y', roic.growthCapex2y != null ? M(roic.growthCapex2y) : 'Pendiente');
  setEl('roic-gcapex-3y', roic.growthCapex3y != null ? M(roic.growthCapex3y) : 'Pendiente');
  setEl('roic-selected', Pct(roic.roic3yr));

  // ===== CHARTS =====
  destroyChart('c-roic'); destroyChart('c-ic-donut');
  const c1 = document.getElementById('c-roic');
  if (c1 && roic.roicHistory) {
    charts['c-roic'] = new Chart(c1, {
      type:'line', data:{ labels:years,
        datasets:[
          {label:'ROIC (%)',  data:roic.roicHistory, borderColor:'#b88b47', backgroundColor:'rgba(184,139,71,0.1)', tension:0.3, fill:true, pointRadius:4},
          {label:`WACC (${fmtDec(waccPct,2)}%)`, data:Array(years.length).fill(waccPct), borderColor:'#9b2335', borderDash:[5,3], pointRadius:0},
        ]},
      options: chartOpts('%','ROIC vs WACC (%)')
    });
  }
  // IC composition donut
  const c2 = document.getElementById('c-ic-donut');
  if (c2 && roic.investedCapital) {
    const cats = roic.investedCapital.filter(c => c.value !== 0);
    const totalIC = roic.icHistory[N-1];
    const sumCats = cats.reduce((a,c)=>a+c.value, 0);
    const negEquity = totalIC - sumCats;
    if (Math.abs(negEquity) > 1) cats.push({label:'(Negative Equity)', value: negEquity});
    charts['c-ic-donut'] = new Chart(c2, {
      type:'doughnut',
      data:{
        labels: cats.map(c => `${c.label} (${M(c.value)})`),
        datasets:[{
          data: cats.map(c => Math.abs(c.value)),
          backgroundColor:['#1B2642','#b88b47','#9b2335','#2a7a56','#c9a96e','#5c6b8a'],
          borderWidth: 2,
          borderColor: '#FFFFFF'
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'58%',
        plugins:{legend:{position:'right', labels:{font:{family:'Helvetica Neue',size:11},color:'#5c6671',boxWidth:12}}}
      }
    });
  }

  // ===== MAIN TABLE — derived sections: IC build-up | ROIC accounting | Marginal ROIC YoY | Marginal ROIC Acc Growth Capex =====
  // Build derived rows from history arrays
  const fin = D.financials;
  const nopatH = roic.nopatHistory;
  const icH    = roic.icHistory;
  const roicH  = roic.roicHistory;
  // YoY deltas (first year null)
  const dNopat  = nopatH.map((v,i) => i===0 ? null : v - nopatH[i-1]);
  const dIcH    = icH.map((v,i)    => i===0 ? null : v - icH[i-1]);
  const margYoY = dNopat.map((dn,i) => {
    if (dn == null || dIcH[i] == null || Math.abs(dIcH[i]) < 1) return null;
    return (dn / dIcH[i]) * 100;
  });
  // Accumulated growth capex 2yr rolling — derive capex & D&A from cfRows when not provided directly
  const findRow = (rows, names) => {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (!r || !r.l) continue;
      const lower = r.l.toLowerCase();
      if (names.some(n => lower.includes(n))) return Array.isArray(r.v) ? r.v : null;
    }
    return null;
  };
  const capexH = fin.capexHistory || findRow(fin.cfRows, ['capital expenditure','capex']) || [];
  const daH    = fin.daHistory    || findRow(fin.cfRows, ['depreciation & amortization','depreciation and amortization','d&a']) || [];
  const sgaGrowthH = roic.smGrowthHistory || [];   // optional Supabase field
  const accGCapex2y = years.map((_, i) => {
    if (i < 1) return null;
    if (capexH.length === 0 || daH.length === 0) return null;
    // Growth capex = |capex| − d&a (when positive, else 0). 2yr rolling.
    const g0 = Math.max(0, Math.abs(capexH[i-1]||0) - (daH[i-1]||0)) + (sgaGrowthH[i-1]||0);
    const g1 = Math.max(0, Math.abs(capexH[i]||0)   - (daH[i]||0))   + (sgaGrowthH[i]||0);
    return g0 + g1;
  });
  const dNopat2y = nopatH.map((v,i) => i<2 ? null : v - nopatH[i-2]);
  const margAcc2y = accGCapex2y.map((g,i) => {
    if (g == null || dNopat2y[i] == null || Math.abs(g) < 1) return null;
    return (dNopat2y[i] / g) * 100;
  });
  const growthCapexYr = years.map((_, i) => {
    if (capexH.length === 0 || daH.length === 0) return null;
    return Math.max(0, Math.abs(capexH[i]||0) - (daH[i]||0));
  });

  // Compose icRows with NEW sections (replacing the old icRows which only had build-up + return)
  const composedRows = [];
  // SECTION 1: Invested Capital build-up + ROIC (use existing icRows as base, they already have build-up + RETURN)
  if (roic.icRows) {
    roic.icRows.forEach(r => {
      const cloned = { ...r };
      // Add Spread vs WACC under ROIC %
      composedRows.push(cloned);
      if (cloned.l === 'ROIC %' || cloned.l === 'ROIC' || cloned.l === 'Adjusted ROIC') {
        composedRows.push({
          l: `Spread vs WACC (${fmtDec(waccPct,2)}%)`,
          t: 'normal',
          v: roicH.map(r => r - waccPct),
          isPct: true,
          dim: true
        });
      }
    });
  }
  // SECTION 2: Marginal ROIC YoY
  composedRows.push({ l: 'MARGINAL ROIC — YOY DELTAS', t: 'section' });
  composedRows.push({ l: 'Δ NOPAT',          t: 'normal', v: dNopat });
  composedRows.push({ l: 'Δ Invested Capital', t: 'normal', v: dIcH });
  composedRows.push({ l: 'Marginal ROIC (ΔNOPAT / ΔIC)', t: 'subtotal', v: margYoY, isPct: true });
  // SECTION 3: Marginal ROIC — Accumulated Growth CapEx 2yr
  composedRows.push({ l: 'MARGINAL ROIC — ACC. GROWTH CAPEX', t: 'section' });
  if (capexH.length > 0 && daH.length > 0) {
    composedRows.push({ l: 'Growth CapEx (CapEx − D&A)',     t: 'normal', v: growthCapexYr });
    composedRows.push({ l: 'S&M Growth Expense (memo)',       t: 'normal', v: sgaGrowthH.length === N ? sgaGrowthH : Array(N).fill(null) });
    composedRows.push({ l: 'Accumulated Growth CapEx (2yr rolling)', t: 'normal', v: accGCapex2y });
    composedRows.push({ l: 'Δ NOPAT (2yr)',                  t: 'normal', v: dNopat2y });
    composedRows.push({ l: 'Marginal ROIC Accumulated (2yr)', t: 'subtotal', v: margAcc2y, isPct: true });
  } else {
    composedRows.push({ l: 'Growth CapEx history not yet loaded in Supabase', t: 'normal', v: Array(N).fill(null), dim: true });
  }

  renderTable('tbl-roic', composedRows, years, fin);
}

/* ════════════════════════════════════════════════════════════
   7. IMPLIED IRR — BKNG-style: 6 sliders + EV/Dist/Reinv decomp
   ════════════════════════════════════════════════════════════ */
let irrState = {};
let irrBase  = {};

function renderIrr() {
  const irr = D.irr || {};
  irrState = { ...irr };
  irrBase  = { ...irr };

  // Slider bounds (consistent with Excel sensitivity ranges)
  const buyMax = Math.max(2000, Math.round((irr.buybacks || 500) * 3 / 100) * 100);
  const sliders = [
    { id:'sl-irr-roic',     field:'selectedRoic',  val:irr.selectedRoic,  min:5,    max:60,  step:0.5, fmt:v=>`${fmtDec(v,1)}%`, note:'Capital efficiency on new investments (3yr avg pre-tax ROIC)' },
    { id:'sl-irr-organic',  field:'organicGrowth', val:irr.organicGrowth, min:0,    max:15,  step:0.5, fmt:v=>`${fmtDec(v,1)}%`, note:'Same-store / pricing growth without new capital' },
    { id:'sl-irr-exit',     field:'exitMultiple',  val:irr.exitMultiple,  min:8,    max:35,  step:1,   fmt:v=>`${v}×`,            note:'Exit EV/NOPAT multiple at end of horizon' },
    { id:'sl-irr-buybacks', field:'buybacks',      val:irr.buybacks || 0, min:0,    max:buyMax, step:50, fmt:v=>`${sym()}${fmt(v)}M`, note:'Annual sustainable buybacks (USD millions)' },
    { id:'sl-irr-horizon',  field:'horizon',       val:irr.horizon,       min:3,    max:10,  step:1,   fmt:v=>`${v} yr`,         note:'Investment horizon for IRR calc' },
    { id:'sl-irr-hurdle',   field:'hurdle',        val:irr.hurdle,        min:6,    max:18,  step:0.5, fmt:v=>`${fmtDec(v,1)}%`, note:'DCE minimum return required to deploy capital' }
  ];
  sliders.forEach(sl => {
    setSlider(sl.id, sl.val, sl.min, sl.max, sl.step);
    const key = sl.id.replace('sl-irr-','');
    setEl(`sl-irr-${key}-val`, sl.fmt(sl.val));
    const minEl = document.getElementById(`sl-irr-${key}-min`);
    const maxEl = document.getElementById(`sl-irr-${key}-max`);
    if (minEl) minEl.textContent = sl.fmt(sl.min);
    if (maxEl) maxEl.textContent = sl.fmt(sl.max);
    const noteEl = document.getElementById(`sl-irr-${key}-note`);
    if (noteEl) noteEl.textContent = sl.note;
  });

  updateIRRCalc();
}

function onIRRSlider(field, val) {
  irrState[field] = parseFloat(val);
  // Map field → slider key (most are direct, some shorter)
  const keyMap = { selectedRoic:'roic', organicGrowth:'organic', exitMultiple:'exit', buybacks:'buybacks', horizon:'horizon', hurdle:'hurdle' };
  const key = keyMap[field] || field;
  const dispEl = document.getElementById(`sl-irr-${key}-val`);
  if (dispEl) {
    if (field === 'buybacks')         dispEl.textContent = `${sym()}${fmt(val)}M`;
    else if (field === 'exitMultiple') dispEl.textContent = `${val}×`;
    else if (field === 'horizon')      dispEl.textContent = `${val} yr`;
    else                                dispEl.textContent = `${fmtDec(parseFloat(val),1)}%`;
  }
  updateIRRCalc();
}

function resetIRRAssumptions() {
  irrState = { ...irrBase };
  renderIrr();
}

function updateIRRCalc() {
  const s    = irrState;
  const irr  = D.irr || {};
  const ov   = D.overview || {};
  const fin  = D.financials || {};
  const epv  = D.epv || {};

  // ===== Core inputs =====
  const nopat = irr.nopat || epv.nopatBase || 0;
  const ev    = irr.ev   || ov.ev || 0;
  const mcap  = ov.marketCap || (ev - (ov.debt||0) - (ov.leases||0) + (ov.cash||0));
  const debt  = ov.debt || 0;
  const leases = ov.leases || 0;
  const cash = ov.cash || 0;
  const actualMult = nopat > 0 ? ev / nopat : 0;

  // ===== Auto-derive financial inputs from cfRows =====
  const findRow = (rows, names) => {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (!r || !r.l) continue;
      const lower = r.l.toLowerCase();
      if (names.some(n => lower.includes(n))) return Array.isArray(r.v) ? r.v : null;
    }
    return null;
  };
  const last = (arr) => Array.isArray(arr) && arr.length ? arr[arr.length-1] : null;
  const capexH = fin.capexHistory || findRow(fin.cfRows, ['capital expenditure','capex']) || [];
  const daH    = fin.daHistory    || findRow(fin.cfRows, ['depreciation & amortization','depreciation and amortization','d&a']) || [];
  const wcH    = findRow(fin.cfRows, ['changes in working capital','working capital']) || [];
  const dividendsH = fin.dividends || findRow(fin.cfRows, ['dividends paid','dividends']) || [];
  const interestH  = findRow(fin.isRows, ['interest expense']) || [];

  // Latest FY values (use absolute for outflows so we display positive)
  const capexLatest = Math.abs(last(capexH) || 0);
  const daLatest    = Math.abs(last(daH) || 0);
  const growthCapex = Math.max(0, capexLatest - daLatest);
  const dWC         = Math.abs(last(wcH) || 0);                       // proxy for ΔWC
  const divLatest   = Math.abs(last(dividendsH) || irr.dividends || 0);
  const intLatest   = Math.abs(last(interestH) || irr.interest || 0);
  // Excel parity: incluir S&M Growth Expense + R&D Growth Expense en Total Reinversión
  const adj = D.adj || {};
  const lastNonNull = (arr) => {
    if (!Array.isArray(arr)) return 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] != null) return arr[i]; }
    return 0;
  };
  const smGrowth    = adj.smGrowthExp != null ? adj.smGrowthExp : lastNonNull(adj.smGrowthHistory);
  const rdGrowth    = adj.rdGrowthExp != null ? adj.rdGrowthExp : lastNonNull(adj.rdGrowthHistory);

  // ===== Distributions (uses slider buybacks; div/int from latest FY) =====
  const buybacks = s.buybacks  || 0;
  const dist     = divLatest + buybacks + intLatest;
  const distYield = ev > 0 ? (dist / ev) * 100 : 0;
  const payoutRate = nopat > 0 ? (dist / nopat) * 100 : 0;

  // ===== Reinvestment =====
  const totalReinv = growthCapex + dWC + smGrowth + rdGrowth;
  const reinvRate  = nopat > 0 ? (totalReinv / nopat) * 100 : 0;

  // ===== Growth decomposition =====
  const reinvGrowth = reinvRate * (s.selectedRoic / 100);   // pp
  const totalGrowth = reinvGrowth + s.organicGrowth;

  // ===== Multiple adjustment (annualized) =====
  const multImpact = actualMult > 0 && s.horizon > 0
    ? (Math.pow(s.exitMultiple / actualMult, 1/s.horizon) - 1) * 100
    : 0;

  // ===== Leverage Equity (MM lever-up) =====
  // Equity return ≈ EV return + (D/E) × (EV return − pre-tax cost of debt)
  // Excel parity: D/E (Mercado) = (Debt + Leases) / MCap (gross leverage, incluyendo leases)
  const evReturn = distYield + totalGrowth + multImpact;
  const grossDebt  = debt + leases;
  const eqVal    = Math.max(1, mcap);
  const dOverE   = grossDebt / eqVal;
  const preTaxCost = irr.netBorrowCost || 0;
  const leverageEq = dOverE * (evReturn - preTaxCost);     // pp

  // ===== Total equity return =====
  const totalIRR = evReturn + leverageEq;
  const mos      = totalIRR - s.hurdle;

  // ===== HERO =====
  const heroColor = totalIRR >= s.hurdle ? 'var(--green)' : 'var(--red)';
  setEl('irr-total', `<span style="color:${heroColor}">${Pct(totalIRR)}</span>`);
  const mosCls  = mos >= 0 ? 'green' : 'red';
  const mosSign = mos >= 0 ? '+' : '';
  setEl('irr-mos', `<span class="${mosCls}">${mosSign}${Pct(mos)}</span>`);
  setEl('irr-mos-sub', `vs. Hurdle Rate ${Pct(s.hurdle)}`);
  setEl('irr-actual-mult', `${fmtDec(actualMult,1)}×`);
  setEl('irr-actual-mult-sub', `Exit ${s.exitMultiple}× → ${Pct(multImpact)} p.a.`);

  // ===== DECOMPOSITION BARS =====
  const maxAbs = Math.max(8, Math.abs(distYield), Math.abs(s.organicGrowth), Math.abs(reinvGrowth), Math.abs(multImpact), Math.abs(leverageEq), Math.abs(totalIRR));
  function setBar(barId, pctId, val) {
    const bar = document.getElementById(barId);
    if (bar) {
      bar.style.width = Math.min(100, Math.abs(val)/maxAbs*100) + '%';
      bar.style.backgroundColor = val >= 0 ? '#2a7a56' : '#9b2335';
    }
    const pct = document.getElementById(pctId);
    if (pct) {
      const sign = val > 0 ? '+' : '';
      pct.textContent = `${sign}${Pct(val)}`;
      pct.className = `ipct ${val >= 0 ? 'green' : 'red'}`;
    }
  }
  setBar('irr-bar-dist-yield',   'irr-dist-yield',   distYield);
  setBar('irr-bar-organic',      'irr-organic',      s.organicGrowth);
  setBar('irr-bar-reinv-growth', 'irr-reinv-growth', reinvGrowth);
  setBar('irr-bar-mult-impact',  'irr-mult-impact',  multImpact);
  setBar('irr-bar-leverage',     'irr-leverage',     leverageEq);
  // Total bar (always navy)
  const totBar = document.getElementById('irr-bar-total');
  if (totBar) totBar.style.width = Math.min(100, Math.abs(totalIRR)/maxAbs*100) + '%';
  const totEl = document.getElementById('irr-total-bar');
  if (totEl) {
    totEl.textContent = Pct(totalIRR);
    totEl.className = `ipct ${totalIRR >= 0 ? 'green' : 'red'}`;
    totEl.style.fontWeight = '700';
  }

  // ===== EV BUILD =====
  const M = (v) => v == null ? '—' : `${sym()}${fmt(v)}M`;
  setEl('irr-ev-mcap',   M(mcap));
  setEl('irr-ev-debt',   M(debt));
  setEl('irr-ev-leases', M(leases));
  setEl('irr-ev-cash',   `(${M(cash)})`);
  setEl('irr-ev-total',  M(ev));
  setEl('irr-ev-mult',   `${fmtDec(actualMult,1)}×`);

  // ===== DISTRIBUTIONS =====
  setEl('irr-dist-div',         M(divLatest));
  setEl('irr-dist-buy',         M(buybacks));
  setEl('irr-dist-int',         M(intLatest));
  setEl('irr-dist-total',       M(dist));
  setEl('irr-dist-yield-calc',  Pct(distYield));
  setEl('irr-dist-payout',      Pct(payoutRate));

  // ===== REINVESTMENT =====
  if (capexH.length === 0 || daH.length === 0) {
    setEl('irr-reinv-gcapex', '<span class="dim">Pendiente</span>');
  } else {
    setEl('irr-reinv-gcapex', M(growthCapex));
  }
  setEl('irr-reinv-wc',    M(dWC));
  setEl('irr-reinv-sm',    smGrowth > 0 ? M(smGrowth) : '<span class="dim">Pendiente</span>');
  setEl('irr-reinv-rd',    rdGrowth > 0 ? M(rdGrowth) : '<span class="dim">N/A</span>');
  setEl('irr-reinv-total', M(totalReinv));
  setEl('irr-reinv-rate',  Pct(reinvRate));

  // ===== GROWTH DECOMPOSITION =====
  setEl('irr-gd-roic',        Pct(s.selectedRoic));
  setEl('irr-gd-reinv',       Pct(reinvRate));
  setEl('irr-gd-reinvgrowth', Pct(reinvGrowth));
  setEl('irr-gd-organic',     Pct(s.organicGrowth));
  setEl('irr-gd-total',       Pct(totalGrowth));

  // ===== CASH SANITY CHECK =====
  const netCash = nopat - totalReinv - dist;
  const netCashPct = nopat > 0 ? (netCash / nopat) * 100 : 0;
  setEl('irr-cs-nopat', M(nopat));
  setEl('irr-cs-reinv', `(${M(totalReinv)})`);
  setEl('irr-cs-dist',  `(${M(dist)})`);
  const netCls = netCash >= 0 ? 'green' : 'red';
  setEl('irr-cs-net',   `<span class="${netCls}">${M(netCash)}</span>`);
  setEl('irr-cs-pct',   `<span class="${netCls}">${Pct(netCashPct)}</span>`);
  let note;
  if (netCash >= 0 && netCashPct < 20) {
    note = 'Reinversión + distribución absorben casi todo el NOPAT — sostenible pero sin colchón. Si se materializa un downturn, hay que reducir buybacks antes que CapEx de crecimiento.';
  } else if (netCash >= 0) {
    note = 'Sobra cash después de reinvertir y distribuir — colchón saludable para opcionalidad (M&A, debt paydown, buybacks oportunísticos).';
  } else {
    note = 'Atención: NOPAT no cubre Reinversión + Distribución actual. O bien el supuesto de buybacks no es sostenible, o la empresa está apalancando para distribuir.';
  }
  setEl('irr-cs-note', note);
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
// Helper: normalize ROIC value — if it's a fraction (<1) multiply by 100; if already %, leave it.
function roicPct(v) { return v == null ? null : (v < 1 ? v * 100 : v); }

// Helper: replicate IRR tab calc using base assumptions so Summary stays in sync.
function computeImpliedIrr() {
  const irr = D.irr || {};
  const ov  = D.overview || {};
  const fin = D.financials || {};
  const epv = D.epv || {};
  const nopat = irr.nopat || epv.nopatBase || 0;
  const ev    = irr.ev   || ov.ev || 0;
  const mcap  = ov.marketCap || 0;
  const findRow = (rows, names) => {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (!r || !r.l) continue;
      const lower = r.l.toLowerCase();
      if (names.some(n => lower.includes(n))) return Array.isArray(r.v) ? r.v : null;
    }
    return null;
  };
  const last = (a) => Array.isArray(a) && a.length ? a[a.length-1] : 0;
  const capexH = fin.capexHistory || findRow(fin.cfRows, ['capital expenditure','capex']) || [];
  const daH    = fin.daHistory    || findRow(fin.cfRows, ['depreciation & amortization','depreciation and amortization','d&a']) || [];
  const wcH    = findRow(fin.cfRows, ['changes in working capital','working capital']) || [];
  const dividendsH = fin.dividends || findRow(fin.cfRows, ['dividends paid','dividends']) || [];
  const interestH  = findRow(fin.isRows, ['interest expense']) || [];
  const growthCapex = Math.max(0, Math.abs(last(capexH)) - Math.abs(last(daH)));
  const dWC         = Math.abs(last(wcH));
  // Excel parity: Total Reinversión = Growth CapEx + ΔWC + S&M Growth Expense + R&D Growth Expense
  const smGrowthExp = (D.adj && (D.adj.smGrowthExp != null ? D.adj.smGrowthExp
                                                          : (Array.isArray(D.adj.smGrowthHistory) ? last(D.adj.smGrowthHistory.filter(x=>x!=null)) : 0))) || 0;
  const rdGrowthExp = (D.adj && (D.adj.rdGrowthExp != null ? D.adj.rdGrowthExp : 0)) || 0;
  const divLatest   = Math.abs(last(dividendsH) || irr.dividends || 0);
  const intLatest   = Math.abs(last(interestH)  || irr.interest  || 0);
  const buybacks    = irr.buybacks || 0;
  const dist        = divLatest + buybacks + intLatest;
  const distYield   = ev > 0 ? (dist / ev) * 100 : 0;
  const totalReinv  = growthCapex + dWC + smGrowthExp + rdGrowthExp;
  const reinvRate   = nopat > 0 ? (totalReinv / nopat) * 100 : 0;
  const reinvGrowth = reinvRate * ((irr.selectedRoic || 0) / 100);
  const totalGrowth = reinvGrowth + (irr.organicGrowth || 0);
  const actualMult  = nopat > 0 ? ev / nopat : 0;
  const multImpact  = actualMult > 0 && irr.horizon > 0
    ? (Math.pow((irr.exitMultiple || actualMult) / actualMult, 1/irr.horizon) - 1) * 100
    : 0;
  const evReturn    = distYield + totalGrowth + multImpact;
  // Excel parity: D/E (Mercado) = (Debt + Leases) / MCap (gross leverage, not net)
  const grossDebt   = (ov.debt||0) + (ov.leases||0);
  const eqVal       = Math.max(1, mcap);
  const dOverE      = grossDebt / eqVal;
  const leverageEq  = dOverE * (evReturn - (irr.netBorrowCost || 0));
  return {
    totalIRR: evReturn + leverageEq,
    reinvGrowth, reinvRate, distYield, totalGrowth, multImpact, leverageEq, actualMult
  };
}

function renderSummary() {
  const ts = D.thesisSummary;
  const ov = D.overview;
  const epv = D.epv;

  setEl('memo-narrative', ts.narrative || '');

  // Recompute IRR dynamically so Summary matches IRR tab (no stale static value).
  const irrCalc   = computeImpliedIrr();
  const irrDyn    = irrCalc.totalIRR;
  const mosIrrDyn = irrDyn - (D.irr.hurdle || 0);

  // ── KPI Hero strip (6 numbers that matter) ─────────────────
  const mosEpv   = ts.marginOfSafety;
  const mosColor = mosEpv >= 0 ? 'var(--green)' : 'var(--red)';
  const irrColor = irrDyn >= D.irr.hurdle ? 'var(--green)' : 'var(--red)';
  const peRatio  = ts.priceEpvRatio;
  const peColor  = peRatio < 1 ? 'var(--green)' : peRatio < 1.2 ? 'var(--gold)' : 'var(--red)';
  const roicVal  = roicPct(ov.roic3yr);
  const wacc3    = D.overview.wacc*100;
  const roicColor = roicVal > wacc3 ? 'var(--green)' : 'var(--gray-mid)';

  const kpis = [
    { lbl:'MoS (Price / EPV)', val:`${mosEpv>=0?'+':''}${Pct(mosEpv)}`, color:mosColor,     sub:`EPV ${fmtPrice(epv.epvPerShare)}` },
    { lbl:'Implied IRR',       val:Pct(irrDyn),                          color:irrColor,     sub:`MoS ${mosIrrDyn>=0?'+':''}${Pct(mosIrrDyn)} vs hurdle ${Pct(D.irr.hurdle)}` },
    { lbl:'Price / EPV',       val:Mul(peRatio),                         color:peColor,      sub:`EPV ${fmtPrice(epv.epvPerShare)}` },
    { lbl:'EPV / RV',          val:Mul(ts.epvRvRatio),                   color:'var(--navy)',sub:`RV ${fmtPrice(D.rv.rvPerShare)}` },
    { lbl:'ROIC 3yr avg',      val:Pct(roicVal),                         color:roicColor,    sub:`WACC ${Pct(wacc3)}` },
    { lbl:'Market Cap',        val:B(ov.marketCap),                      color:'var(--navy)',sub:`EV ${B(ov.ev)}` },
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
    ['Implied IRR',      Pct(irrDyn)],
    ['Hurdle Rate',      Pct(D.irr.hurdle)],
    ['MoS (Price/EPV)',  `${mosEpv>=0?'+':''}${Pct(mosEpv)}`],
    ['MoS (IRR/Hurdle)', `${mosIrrDyn>=0?'+':''}${Pct(mosIrrDyn)}`],
    ['WACC',             Pct(wacc3)],
  ];
  const operations = [
    ['Revenue FY2025', M(ov.revenue)],
    ['Op Margin',      Pct(ov.operMargin*100)],
    ['FCF FY2025',     M(ov.fcfLatest)],
    ['FCF Margin',     Pct(ov.fcfMargin*100)],
    ['ROIC (latest)',  Pct(roicPct(ov.roicLatest))],
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
  setEl('ov-irr-reinvg',   Pct(irrCalc.reinvGrowth));
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
