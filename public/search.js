/* DCE Holdings — Global Search (Cmd+K)
 * Self-contained: injects modal, listens to keyboard, builds index on demand.
 * Drop into any page with: <script src="/search.js" defer></script>
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // STATIC INDEX — pages + companies (known at build time)
  // ──────────────────────────────────────────────────────────
  const STATIC_PAGES = [
    { type: 'page', title: 'Home',                 desc: 'Investment Office overview',         url: '/',                 keywords: 'home overview start cockpit' },
    { type: 'page', title: 'Universe',             desc: 'Watchlist of tracked tickers',       url: '/universe.html',    keywords: 'universe watchlist tickers list candidates' },
    { type: 'page', title: 'Find',                 desc: 'Sector screener + superinvestors',    url: '/screener.html',   keywords: 'find screener superinvestors 13F discovery search' },
    { type: 'page', title: 'Portfolio',            desc: 'Live P&L of active holdings',        url: '/portfolio.html',   keywords: 'portfolio holdings positions pnl live' },
    { type: 'page', title: 'News',                 desc: 'Filtered headlines for portfolio',   url: '/news.html',        keywords: 'news headlines press articles' },
    { type: 'page', title: 'Data Room',            desc: 'Reference filings and source data',  url: '/dataroom.html',    keywords: 'data room filings 10-K 10-Q sources documents' },
    { type: 'page', title: 'Reporting Hub',        desc: 'Monthly close, committee, annual',   url: '/reporting.html',   keywords: 'reporting reports monthly close committee annual hub' },
    { type: 'page', title: 'Research Pipeline',    desc: 'Kanban of ideas in progress',        url: '/research.html',    keywords: 'research pipeline kanban ideas backlog supabase' },
    { type: 'page', title: 'Calendar',              desc: 'Earnings dates for covered companies',url: '/calendar.html',    keywords: 'calendar earnings dates schedule events upcoming reports' },
  ];

  // Built-in tickers — extend as we add company JSONs
  const KNOWN_TICKERS = ['BKNG', 'SAP', 'LULU'];

  // Static documents in the GitHub repo (BKNG/SAP institutional deliverables)
  const STATIC_DOCS = [
    { title: 'BKNG · Valuation Report',  url: '/docs/DCE_BKNG_Valuation_Report.pdf', ticker: 'BKNG', kind: 'Valuation Report' },
    { title: 'BKNG · Thesis Breaker',    url: '/docs/DCE_BKNG_Thesis_Breaker.pdf',   ticker: 'BKNG', kind: 'Thesis Breaker'   },
    { title: 'BKNG · Munger Digital',    url: '/docs/DCE_BKNG_Munger_Digital.pdf',   ticker: 'BKNG', kind: 'Munger Digital'   },
    { title: 'SAP · Valuation Report',   url: '/docs/DCE_SAP_Valuation_Report.pdf',  ticker: 'SAP',  kind: 'Valuation Report' },
    { title: 'SAP · Thesis Breaker',     url: '/docs/DCE_SAP_Thesis_Breaker.pdf',    ticker: 'SAP',  kind: 'Thesis Breaker'   },
    { title: 'SAP · Munger Digital',     url: '/docs/DCE_SAP_Munger_Digital.pdf',    ticker: 'SAP',  kind: 'Munger Digital'   },
    { title: 'LULU · Valuation Report',  url: '/docs/DCE_LULU_Valuation_Report.pdf', ticker: 'LULU', kind: 'Valuation Report' },
    { title: 'LULU · Thesis Breaker',    url: '/docs/DCE_LULU_Thesis_Breaker.pdf',   ticker: 'LULU', kind: 'Thesis Breaker'   },
    { title: 'LULU · Munger Digital',    url: '/docs/DCE_LULU_Munger_Digital.pdf',   ticker: 'LULU', kind: 'Munger Digital'   },
  ];

  // ──────────────────────────────────────────────────────────
  // STYLES — injected once
  // ──────────────────────────────────────────────────────────
  const CSS = `
    .dce-search-overlay{position:fixed;inset:0;background:rgba(27,38,66,0.55);z-index:9999;display:none;align-items:flex-start;justify-content:center;padding-top:12vh;backdrop-filter:blur(3px)}
    .dce-search-overlay.show{display:flex}
    .dce-search-panel{background:#fff;border-top:3px solid #b88b47;width:92%;max-width:640px;max-height:72vh;display:flex;flex-direction:column;font-family:'Archivo','Helvetica Neue',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,0.35)}
    .dce-search-input-wrap{display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(27,38,66,0.08)}
    .dce-search-input-wrap svg{flex-shrink:0;margin-right:10px;color:#b88b47}
    .dce-search-input{flex:1;border:0;outline:0;font-family:inherit;font-size:15px;color:#1b2642;background:transparent}
    .dce-search-input::placeholder{color:#8a9098}
    .dce-search-kbd{font-size:9px;letter-spacing:0.1em;color:#8a9098;background:#f5f1eb;padding:3px 6px;border:1px solid rgba(27,38,66,0.08);border-radius:3px;font-weight:600;margin-left:8px}
    .dce-search-results{overflow-y:auto;flex:1;padding:4px 0}
    .dce-search-empty{padding:32px 18px;text-align:center;color:#8a9098;font-size:12px;font-style:italic}
    .dce-search-loading{padding:18px;text-align:center;color:#8a9098;font-size:11px;letter-spacing:0.12em;text-transform:uppercase}
    .dce-search-group{padding:4px 0}
    .dce-search-group-label{font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#b88b47;padding:10px 18px 6px}
    .dce-search-item{display:flex;align-items:center;padding:9px 18px;cursor:pointer;border-left:2px solid transparent;color:#1b2642;text-decoration:none}
    .dce-search-item:hover{background:rgba(184,139,71,0.05)}
    .dce-search-item.active{background:rgba(184,139,71,0.10);border-left-color:#b88b47}
    .dce-search-item-icon{width:24px;flex-shrink:0;font-size:13px;color:#b88b47;font-weight:700}
    .dce-search-item-body{flex:1;min-width:0}
    .dce-search-item-title{font-size:13px;font-weight:600;color:#1b2642;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dce-search-item-title mark{background:rgba(184,139,71,0.3);color:inherit;padding:0 2px;border-radius:2px}
    .dce-search-item-desc{font-size:11px;color:#8a9098;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dce-search-item-meta{font-size:9px;color:#b88b47;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;flex-shrink:0;margin-left:8px}
    .dce-search-footer{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;border-top:1px solid rgba(27,38,66,0.06);font-size:10px;color:#8a9098;background:#fafafa}
    .dce-search-footer span strong{color:#1b2642}
    .dce-search-trigger{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;padding:7px 12px;color:rgba(255,255,255,0.55);background:rgba(255,255,255,0.04);border:1px solid rgba(184,139,71,0.25);cursor:pointer;font-family:inherit;transition:all .2s;margin-left:6px}
    .dce-search-trigger:hover{color:#b88b47;border-color:#b88b47;background:rgba(184,139,71,0.08)}
    .dce-search-trigger kbd{font-size:9px;background:rgba(255,255,255,0.08);padding:2px 5px;border-radius:2px;letter-spacing:0.05em;font-family:inherit}
  `;

  function injectStyles() {
    if (document.getElementById('dce-search-styles')) return;
    const s = document.createElement('style');
    s.id = 'dce-search-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ──────────────────────────────────────────────────────────
  // INDEX BUILDING
  // ──────────────────────────────────────────────────────────
  let INDEX = null;       // [{ type, title, desc, url, meta, keywords }]
  let indexPromise = null;

  async function fetchCompanies() {
    const out = [];
    for (const tk of KNOWN_TICKERS) {
      try {
        const r = await fetch(`/companies/${tk.toLowerCase()}.json`);
        if (!r.ok) continue;
        const d = await r.json();
        const verdict = d?.thesisSummary?.verdict || '—';
        const irr = d?.thesisSummary?.impliedIrr;
        const mos = d?.thesisSummary?.marginOfSafety;
        const desc = `${d.industry || ''} · ${verdict}` +
          (irr != null ? ` · IRR ${irr}%` : '') +
          (mos != null ? ` · MoS ${mos}%` : '');
        out.push({
          type: 'company',
          title: `${d.ticker} — ${d.name}`,
          desc,
          url: `/${tk.toLowerCase()}`,
          keywords: `${d.ticker} ${d.name} ${d.industry || ''} ${verdict} ${d.exchange || ''}`,
          meta: verdict,
        });
      } catch {}
    }
    return out;
  }

  async function fetchSupabaseDocs() {
    const folders = [
      { folder: 'monthly',    label: 'Monthly Close' },
      { folder: 'committee',  label: 'Investment Committee' },
      { folder: 'annual',     label: 'Annual Report' },
    ];
    const out = [];
    for (const { folder, label } of folders) {
      try {
        const r = await fetch(`/api/list-reports?folder=${folder}`);
        if (!r.ok) continue;
        const data = await r.json();
        for (const f of (data.files || [])) {
          const display = f.name.replace(/\.pdf$/i, '').replace(/_/g, ' ');
          out.push({
            type: 'doc',
            title: display,
            desc: `${label} · PDF`,
            url: f.url,
            external: true,
            keywords: `${display} ${label} pdf report ${folder}`,
            meta: label,
          });
        }
      } catch {}
    }
    return out;
  }

  function buildStaticDocsIndex() {
    return STATIC_DOCS.map(d => ({
      type: 'doc',
      title: d.title,
      desc: `${d.kind} · PDF · /docs`,
      url: d.url,
      external: true,
      keywords: `${d.ticker} ${d.kind} ${d.title} pdf`,
      meta: d.kind,
    }));
  }

  function buildStaticPagesIndex() {
    return STATIC_PAGES.map(p => ({ ...p, meta: 'Page' }));
  }

  async function fetchEarnings() {
    const out = [];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    try {
      const r = await fetch('/data/earnings.json', { cache: 'no-store' });
      if (!r.ok) return out;
      const data = await r.json();
      const today = new Date();
      today.setHours(0,0,0,0);
      for (const e of (data.events || [])) {
        const [y,m,d] = e.date.split('-').map(Number);
        const dt = new Date(y, m-1, d);
        const dDays = Math.round((dt - today) / 86400000);
        const fmt = `${months[m-1]} ${d}, ${y}`;
        let when;
        if (e.status === 'reported') when = `Reported · ${fmt}`;
        else if (dDays === 0) when = `Today · ${e.timing}`;
        else if (dDays === 1) when = `Tomorrow · ${e.timing}`;
        else if (dDays > 0) when = `In ${dDays}d · ${fmt}`;
        else when = `${Math.abs(dDays)}d ago · ${fmt}`;

        out.push({
          type: 'event',
          title: `${e.ticker} — ${e.quarter} earnings`,
          desc: `${e.company} · ${when}`,
          url: '/calendar.html',
          keywords: `${e.ticker} ${e.company} earnings ${e.quarter} ${e.timing} call results report`,
          meta: e.status === 'upcoming' ? (dDays >= 0 && dDays <= 7 ? 'Soon' : 'Upcoming') : 'Reported',
        });
      }
    } catch {}
    return out;
  }

  async function buildIndex() {
    if (INDEX) return INDEX;
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
      const [companies, supDocs, earnings] = await Promise.all([
        fetchCompanies(),
        fetchSupabaseDocs(),
        fetchEarnings(),
      ]);
      INDEX = [
        ...buildStaticPagesIndex(),
        ...companies,
        ...buildStaticDocsIndex(),
        ...supDocs,
        ...earnings,
      ];
      return INDEX;
    })();
    return indexPromise;
  }

  // ──────────────────────────────────────────────────────────
  // SCORING — simple but effective fuzzy/substring scoring
  // ──────────────────────────────────────────────────────────
  function scoreItem(item, q) {
    if (!q) return 0;
    const Q = q.toLowerCase();
    const title = item.title.toLowerCase();
    const kw = (item.keywords || '').toLowerCase();
    const desc = (item.desc || '').toLowerCase();

    if (title === Q) return 1000;
    if (title.startsWith(Q)) return 800;
    if (title.includes(' ' + Q)) return 600;
    if (title.includes(Q)) return 400;
    if (kw.includes(Q)) return 200;
    if (desc.includes(Q)) return 100;

    // Fuzzy: every char of Q appears in order in title
    let i = 0;
    for (const c of title) {
      if (c === Q[i]) i++;
      if (i === Q.length) return 50;
    }
    return 0;
  }

  function search(q) {
    if (!INDEX) return [];
    if (!q || !q.trim()) {
      // Default: show all pages first
      return INDEX.filter(x => x.type === 'page').map(x => ({ ...x, _score: 1 }));
    }
    return INDEX
      .map(x => ({ ...x, _score: scoreItem(x, q.trim()) }))
      .filter(x => x._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 30);
  }

  function highlight(text, q) {
    if (!q || !q.trim()) return escapeHtml(text);
    const safeQ = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escapeHtml(text).replace(new RegExp(safeQ, 'ig'), m => `<mark>${m}</mark>`);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ──────────────────────────────────────────────────────────
  // UI
  // ──────────────────────────────────────────────────────────
  let overlay, input, resultsEl, footerEl, currentResults = [], activeIdx = 0;

  const ICONS = { page: '◧', company: '◆', doc: '▤', event: '▸' };
  const GROUPS = [
    { type: 'page',    label: 'Pages' },
    { type: 'company', label: 'Companies' },
    { type: 'event',   label: 'Earnings' },
    { type: 'doc',     label: 'Documents' },
  ];

  function buildModal() {
    if (overlay) return;
    injectStyles();

    overlay = document.createElement('div');
    overlay.className = 'dce-search-overlay';
    overlay.innerHTML = `
      <div class="dce-search-panel" role="dialog" aria-label="Search">
        <div class="dce-search-input-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/>
          </svg>
          <input class="dce-search-input" type="text" placeholder="Search pages, companies, documents…" autocomplete="off" spellcheck="false">
          <span class="dce-search-kbd">ESC</span>
        </div>
        <div class="dce-search-results"><div class="dce-search-loading">Loading index…</div></div>
        <div class="dce-search-footer">
          <span><strong>↑↓</strong> Navigate &nbsp; <strong>↵</strong> Open &nbsp; <strong>Esc</strong> Close</span>
          <span>DCE · Cmd+K</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    input = overlay.querySelector('.dce-search-input');
    resultsEl = overlay.querySelector('.dce-search-results');
    footerEl = overlay.querySelector('.dce-search-footer');

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', onInputKey);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    resultsEl.addEventListener('click', onResultsClick);
  }

  function onInputKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, currentResults.length - 1);
      paintActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = currentResults[activeIdx];
      if (item) navigate(item);
    }
  }

  function onResultsClick(e) {
    const el = e.target.closest('.dce-search-item');
    if (!el) return;
    const idx = parseInt(el.dataset.idx, 10);
    const item = currentResults[idx];
    if (item) navigate(item);
  }

  function navigate(item) {
    close();
    if (item.external) {
      window.open(item.url, '_blank', 'noopener');
    } else {
      window.location.href = item.url;
    }
  }

  function paintActive() {
    const items = resultsEl.querySelectorAll('.dce-search-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    const active = items[activeIdx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function render(q) {
    const results = search(q);
    currentResults = results;
    activeIdx = 0;

    if (!INDEX) {
      resultsEl.innerHTML = '<div class="dce-search-loading">Loading index…</div>';
      return;
    }
    if (results.length === 0) {
      resultsEl.innerHTML = `<div class="dce-search-empty">No results for "${escapeHtml(q)}"</div>`;
      return;
    }

    // Group by type, in display order
    const grouped = {};
    results.forEach((r, i) => {
      r._idx = i;
      (grouped[r.type] = grouped[r.type] || []).push(r);
    });

    let html = '';
    for (const { type, label } of GROUPS) {
      const items = grouped[type];
      if (!items || items.length === 0) continue;
      html += `<div class="dce-search-group"><div class="dce-search-group-label">${label}</div>`;
      for (const it of items) {
        html += `
          <div class="dce-search-item" data-idx="${it._idx}">
            <div class="dce-search-item-icon">${ICONS[type] || '·'}</div>
            <div class="dce-search-item-body">
              <div class="dce-search-item-title">${highlight(it.title, q)}</div>
              <div class="dce-search-item-desc">${escapeHtml(it.desc || '')}</div>
            </div>
            ${it.meta ? `<div class="dce-search-item-meta">${escapeHtml(it.meta)}</div>` : ''}
          </div>
        `;
      }
      html += `</div>`;
    }
    resultsEl.innerHTML = html;
    paintActive();
  }

  // ──────────────────────────────────────────────────────────
  // OPEN / CLOSE
  // ──────────────────────────────────────────────────────────
  async function open() {
    buildModal();
    overlay.classList.add('show');
    input.value = '';
    setTimeout(() => input.focus(), 30);
    if (!INDEX) {
      resultsEl.innerHTML = '<div class="dce-search-loading">Loading index…</div>';
      try {
        await buildIndex();
      } catch (e) {
        resultsEl.innerHTML = '<div class="dce-search-empty">Failed to load index.</div>';
        return;
      }
    }
    render('');
  }

  function close() {
    if (overlay) overlay.classList.remove('show');
  }

  // ──────────────────────────────────────────────────────────
  // GLOBAL HOTKEY + TRIGGER BUTTON
  // ──────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay && overlay.classList.contains('show')) close();
      else open();
    }
  });

  function injectTrigger() {
    // Try .hnav first (most pages), then fallback to home page header structure
    let nav = document.querySelector('.hnav');
    let isHomeFallback = false;

    if (!nav) {
      // Home (index.html): find the link container inside <header> that holds the nav links
      const header = document.querySelector('header');
      if (header) {
        // The links container is the div that contains anchors to /research.html, /news.html, etc.
        const candidates = header.querySelectorAll('div');
        for (const div of candidates) {
          if (div.querySelector('a[href="/reporting.html"]') || div.querySelector('a[href="/research.html"]')) {
            nav = div;
            isHomeFallback = true;
            break;
          }
        }
      }
    }

    if (!nav || nav.querySelector('.dce-search-trigger')) return;
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dce-search-trigger';
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg> Search <kbd>${isMac ? '⌘' : 'Ctrl'}K</kbd>`;
    btn.addEventListener('click', open);

    if (isHomeFallback) {
      // Insert before the divider (the small | separator before the date) to fit the home layout
      const divider = nav.querySelector('div[style*="width:1px"]');
      if (divider) {
        nav.insertBefore(btn, divider);
      } else {
        nav.appendChild(btn);
      }
    } else {
      nav.appendChild(btn);
    }
  }

  function init() {
    injectStyles();
    injectTrigger();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window.DCESearch = { open, close, buildIndex };
})();
