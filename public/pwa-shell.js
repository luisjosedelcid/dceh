/**
 * DCE Holdings — PWA shell enhancements
 *
 * Only active on mobile screens (≤720px). Provides:
 *  - Bottom tab bar (iOS-native feel): Home · Find · Universe · Journal · Menu
 *  - "Menu" opens a bottom sheet with the rest of the app sections
 *  - Hides the desktop top nav on mobile
 *  - Locks overscroll bounce (E)
 *
 * Runs on every page. Safe on desktop (no-op above 720px).
 */
(function () {
  'use strict';

  // ── Ensure viewport-fit=cover on existing meta viewport (for iOS safe-area) ──
  (function ensureViewportFit(){
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    const c = m.getAttribute('content') || '';
    if (!/viewport-fit=/.test(c)) {
      m.setAttribute('content', (c ? c + ', ' : '') + 'viewport-fit=cover');
    }
  })();

  // ── Tab bar spec ───────────────────────────────────────────────
  // Primary tabs (always visible)
  const PRIMARY = [
    { id: 'home',     label: 'Home',     href: '/',                match: ['/', '/index.html', '/landing.html'] },
    { id: 'find',     label: 'Find',     href: '/screener.html',   match: ['/screener.html'] },
    { id: 'universe', label: 'Universe', href: '/universe.html',   match: ['/universe.html', '/company.html'] },
    { id: 'journal',  label: 'Journal',  href: '/journal.html',    match: ['/journal.html', '/premortem.html'] },
    { id: 'menu',     label: 'Menu',     href: '#menu',            match: [] }
  ];

  // Secondary items (bottom sheet)
  const SECONDARY = [
    { label: 'Cockpit',     href: '/cockpit.html' },
    { label: 'Study',       href: '/study.html' },
    { label: 'Portfolio',   href: '/performance.html' },
    { label: 'News',        href: '/news.html' },
    { label: 'Data Room',   href: '/dataroom.html' },
    { label: 'Research',    href: '/research.html' },
    { label: 'Performance', href: '/performance.html' },
    { label: 'Calendar',    href: '/calendar.html' },
    { label: 'Settings',    href: '/settings.html' }
  ];

  // SVG icons — line-style, iOS-flavor
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9.5z"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    universe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="3.5" ry="9"/></svg>',
    journal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h13a2 2 0 012 2v14H6a2 2 0 01-2-2V4z"/><path d="M4 4v14a2 2 0 002 2"/><path d="M8 8h9M8 12h9M8 16h6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></svg>'
  };

  // ── Guard: only run on mobile ─────────────────────────────────
  function isMobile() { return window.matchMedia('(max-width: 720px)').matches; }

  // ── Determine active tab from pathname ────────────────────────
  function activeTab() {
    const p = location.pathname;
    for (const t of PRIMARY) {
      if (t.match.includes(p)) return t.id;
    }
    return null; // no primary match — likely a secondary page
  }

  // ── Build tab bar DOM ─────────────────────────────────────────
  function buildTabBar() {
    if (document.getElementById('dce-tabbar')) return;
    const active = activeTab();

    const nav = document.createElement('nav');
    nav.id = 'dce-tabbar';
    nav.setAttribute('aria-label', 'Primary navigation');
    nav.innerHTML = PRIMARY.map(t => {
      const isActive = t.id === active;
      const isMenu = t.id === 'menu';
      const attr = isMenu ? 'data-menu="1"' : `href="${t.href}"`;
      const tag = isMenu ? 'button' : 'a';
      return `<${tag} class="dce-tab ${isActive ? 'is-active' : ''}" ${attr} data-tab="${t.id}">
        <span class="dce-tab-icon">${ICONS[t.id]}</span>
        <span class="dce-tab-label">${t.label}</span>
      </${tag}>`;
    }).join('');
    document.body.appendChild(nav);

    // Wire "Menu" button
    const menuBtn = nav.querySelector('[data-menu]');
    if (menuBtn) menuBtn.addEventListener('click', openMenuSheet);
  }

  // ── Bottom sheet (Menu) ───────────────────────────────────────
  function openMenuSheet() {
    if (document.getElementById('dce-sheet')) return;
    const overlay = document.createElement('div');
    overlay.id = 'dce-sheet-overlay';
    const sheet = document.createElement('div');
    sheet.id = 'dce-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'More sections');
    sheet.innerHTML = `
      <div class="dce-sheet-handle"></div>
      <div class="dce-sheet-title">More</div>
      <div class="dce-sheet-grid">
        ${SECONDARY.map(s => `<a class="dce-sheet-item" href="${s.href}">${s.label}</a>`).join('')}
      </div>
      <button class="dce-sheet-close" type="button" aria-label="Close menu">Close</button>
    `;
    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
    document.body.classList.add('dce-sheet-open');

    // Trigger enter animation
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      sheet.classList.add('is-open');
    });

    const close = () => closeMenuSheet();
    overlay.addEventListener('click', close);
    sheet.querySelector('.dce-sheet-close').addEventListener('click', close);
    document.addEventListener('keydown', escClose);

    function escClose(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escClose);
      }
    }
  }

  function closeMenuSheet() {
    const overlay = document.getElementById('dce-sheet-overlay');
    const sheet = document.getElementById('dce-sheet');
    if (!overlay || !sheet) return;
    overlay.classList.remove('is-open');
    sheet.classList.remove('is-open');
    setTimeout(() => {
      overlay.remove();
      sheet.remove();
      document.body.classList.remove('dce-sheet-open');
    }, 220);
  }

  // ── Native Share button (top-right floating on mobile) ────────
  function buildShareBtn() {
    if (document.getElementById('dce-share-fab')) return;
    if (!navigator.share) return; // graceful skip if unsupported
    const btn = document.createElement('button');
    btn.id = 'dce-share-fab';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Share this page');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>';
    btn.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: document.title || 'DCE Holdings',
          text: (document.querySelector('meta[name="description"]') || {}).content || 'DCE Holdings',
          url: location.href
        });
      } catch (e) {
        // user cancelled or unsupported — no-op
      }
    });
    document.body.appendChild(btn);
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    if (!isMobile()) return;
    buildTabBar();
    buildShareBtn();
    // Padding at page bottom so content doesn't hide behind tab bar
    document.body.classList.add('dce-has-tabbar');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-check on resize (rotation, split-view)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const tb = document.getElementById('dce-tabbar');
      if (isMobile() && !tb) init();
      if (!isMobile() && tb) {
        tb.remove();
        const sb = document.getElementById('dce-share-fab');
        if (sb) sb.remove();
        document.body.classList.remove('dce-has-tabbar');
        closeMenuSheet();
      }
    }, 150);
  });
})();
