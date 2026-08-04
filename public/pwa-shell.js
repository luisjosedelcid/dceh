/**
 * DCE Holdings — PWA shell enhancements
 *
 * Only active on mobile screens (≤820px — iPhone + iPad Mini portrait). Provides:
 *  - Bottom tab bar (iOS-native feel): Cockpit · Feed · Universe · Performance · Menu
 *  - "Menu" opens a bottom sheet with the rest of the app sections
 *  - Hides the desktop top nav on mobile
 *  - Locks overscroll bounce (E)
 *
 * Runs on every page. Safe on desktop (no-op above 820px).
 */
(function () {
  'use strict';

  // ── Face ID / PIN gate (runs before anything else) ──
  // Only enforced on iOS (iPhone/iPad), where Face ID lives. On Mac and
  // other desktop browsers we rely on the existing admin-token flow, so
  // this gate is a no-op there.
  // Redirects to /lock.html unless the current tab has been unlocked
  // (sessionStorage 'dce_auth_ok'=1) or an emergency admin_token query
  // param is present.
  (function authGate(){
    // Detect iOS. iPadOS 13+ reports as 'MacIntel' but adds touch support,
    // so we also check for touch + Apple platform to catch that case.
    const ua = navigator.userAgent || '';
    const isIPhone = /iPhone|iPod/.test(ua);
    const isIPad =
      /iPad/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isIOS = isIPhone || isIPad;
    if (!isIOS) return;

    const path = location.pathname;
    // Whitelist pages that must be reachable without unlock
    const PUBLIC = ['/lock.html', '/enroll.html', '/admin-login.html'];
    if (PUBLIC.includes(path)) return;

    // Emergency bypass via URL: ?admin_token=<hex>
    const params = new URLSearchParams(location.search);
    const emergencyToken = params.get('admin_token');
    if (emergencyToken) {
      localStorage.setItem('dce_admin_token', emergencyToken);
      sessionStorage.setItem('dce_auth_ok', '1');
      // Strip the token from the URL for hygiene
      params.delete('admin_token');
      const qs = params.toString();
      history.replaceState({}, '', path + (qs ? '?' + qs : ''));
      return;
    }

    // Already unlocked in this browser session
    if (sessionStorage.getItem('dce_auth_ok') === '1') return;

    // Otherwise: redirect to lock screen, remembering where the user was heading
    const ret = encodeURIComponent(path + location.search + location.hash);
    location.replace('/lock.html?return=' + ret);
  })();

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
    { id: 'cockpit',  label: 'Cockpit',  href: '/cockpit.html',    match: ['/cockpit.html'] },
    { id: 'feed',     label: 'Feed',     href: '#feed',            match: ['/screener.html#ideafeed', '/news.html', '/calendar.html'] },
    { id: 'universe', label: 'Universe', href: '/universe.html',   match: ['/universe.html', '/company.html'] },
    { id: 'performance', label: 'Performance', href: '/performance.html', match: ['/performance.html'] },
    { id: 'menu',     label: 'Menu',     href: '#menu',            match: [] }
  ];

  // Feed popover destinations (tap on Feed opens a small action sheet)
  const FEED_OPTIONS = [
    { label: 'Ideas',           href: '/screener.html#ideafeed' },
    { label: 'Portfolio News',  href: '/news.html' },
    { label: 'Calendar',        href: '/calendar.html' }
  ];

  // Secondary items (bottom sheet — hidden pages)
  const SECONDARY = [
    { label: 'Home',      href: '/' },
    { label: 'Find',      href: '/screener.html' },
    { label: 'Journal',   href: '/journal.html' },
    { label: 'Study',     href: '/study.html' },
    { label: 'Data Room', href: '/dataroom.html' },
    { label: 'Research',  href: '/research.html' },
    { label: 'Settings',  href: '/settings.html' }
  ];

  // SVG icons — line-style, iOS-flavor
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9.5z"/></svg>',
    cockpit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7.5 9l1.6 1.6L12 8"/><path d="M14 9.2h4"/><path d="M7.5 15l1.6 1.6L12 14"/><path d="M14 15.2h4"/></svg>',
    feed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/><circle cx="18" cy="18" r="1.5" fill="currentColor"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    universe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="3.5" ry="9"/></svg>',
    performance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></svg>'
  };

  // ── Guard: only run on mobile ─────────────────────────────────
  function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

  // ── Determine active tab from pathname (and hash when specified) ─
  function activeTab() {
    const p = location.pathname;
    const ph = p + (location.hash || '');
    for (const t of PRIMARY) {
      // A match entry containing '#' must match path+hash exactly;
      // plain-path entries only need pathname equality.
      for (const m of t.match) {
        if (m.includes('#')) { if (m === ph) return t.id; }
        else if (m === p) return t.id;
      }
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
      const isSheet = t.id === 'menu' || t.id === 'feed';
      const attr = isSheet ? `data-sheet="${t.id}"` : `href="${t.href}"`;
      const tag = isSheet ? 'button' : 'a';
      return `<${tag} class="dce-tab ${isActive ? 'is-active' : ''}" ${attr} data-tab="${t.id}">
        <span class="dce-tab-icon">${ICONS[t.id]}</span>
        <span class="dce-tab-label">${t.label}</span>
      </${tag}>`;
    }).join('');
    document.body.appendChild(nav);

    // Haptic on any tab tap (Android; iOS silently ignores)
    nav.querySelectorAll('.dce-tab').forEach(t => {
      t.addEventListener('click', () => haptic(8));
    });

    // Wire "Menu" and "Feed" buttons (both open bottom sheets)
    const menuBtn = nav.querySelector('[data-sheet="menu"]');
    if (menuBtn) menuBtn.addEventListener('click', openMenuSheet);
    const feedBtn = nav.querySelector('[data-sheet="feed"]');
    if (feedBtn) feedBtn.addEventListener('click', openFeedSheet);
  }

  // ── Feed action sheet (Ideas / Portfolio News / Calendar) ───────
  function openFeedSheet() {
    if (document.getElementById('dce-sheet')) return;
    const overlay = document.createElement('div');
    overlay.id = 'dce-sheet-overlay';
    const sheet = document.createElement('div');
    sheet.id = 'dce-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Feed sections');
    sheet.innerHTML = `
      <div class="dce-sheet-handle"></div>
      <div class="dce-sheet-title">Feed</div>
      <div class="dce-sheet-feed">
        ${FEED_OPTIONS.map(o => `<a class="dce-sheet-feed-item" href="${o.href}" data-feed-href="${o.href}">
          <span class="dce-sheet-feed-label">${o.label}</span>
          <span class="dce-sheet-feed-arrow">→</span>
        </a>`).join('')}
      </div>
      <button class="dce-sheet-close" type="button" aria-label="Close feed">Close</button>
    `;
    document.body.appendChild(overlay);
    document.body.appendChild(sheet);

    // If the destination is the same pathname (i.e. we're already on /screener.html
    // and the user taps Ideas which goes to /screener.html#ideafeed), the browser
    // will only change the hash — no DOMContentLoaded fires. Force a full load so
    // the applyHashMode() runs cleanly. Use replace() with a cache-buster query
    // to guarantee a fresh navigation on iOS.
    sheet.querySelectorAll('[data-feed-href]').forEach(a => {
      a.addEventListener('click', (ev) => {
        const target = a.getAttribute('data-feed-href') || '';
        const [targetPath, targetHash = ''] = target.split('#');
        if (targetPath === location.pathname) {
          ev.preventDefault();
          closeMenuSheet();
          const cacheBust = '_r=' + Date.now();
          const sep = targetPath.includes('?') ? '&' : '?';
          location.replace(targetPath + sep + cacheBust + (targetHash ? '#' + targetHash : ''));
        }
      });
    });
    document.body.classList.add('dce-sheet-open');

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
      <button class="dce-sheet-signout" type="button" data-signout="1" style="display:block;width:calc(100% - 32px);margin:16px auto 0;padding:14px;border:1px solid rgba(184,139,71,0.4);border-radius:10px;background:transparent;color:#B88B47;font-family:Archivo,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer">Sign out</button>
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
    const signoutBtn = sheet.querySelector('[data-signout]');
    if (signoutBtn) {
      signoutBtn.addEventListener('click', () => {
        if (!confirm('Sign out and return to lock screen?')) return;
        try {
          localStorage.removeItem('dce_admin_token');
          localStorage.removeItem('dce_admin_token_exp');
          localStorage.removeItem('dce_admin_user');
          sessionStorage.removeItem('dce_auth_ok');
          sessionStorage.removeItem('dce_auth');
        } catch {}
        window.location.href = '/lock.html';
      });
    }
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

  // ── Haptic feedback (L) ──────────────────────────────
  // navigator.vibrate: Android/Chrome supported, iOS Safari ignored.
  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) {}
  }

  // ── SW update banner (P) ────────────────────────────
  function showUpdateBanner() {
    if (document.getElementById('dce-update-banner')) return;
    const el = document.createElement('div');
    el.id = 'dce-update-banner';
    el.innerHTML = `
      <span class="dce-update-text">New version available</span>
      <button class="dce-update-btn" type="button">Reload</button>
      <button class="dce-update-close" type="button" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-open'));
    el.querySelector('.dce-update-btn').addEventListener('click', () => location.reload());
    el.querySelector('.dce-update-close').addEventListener('click', () => {
      el.classList.remove('is-open');
      setTimeout(() => el.remove(), 240);
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
        // Check for updates immediately (iOS PWA is aggressive about caching)
        try { reg.update(); } catch (_) {}

        // Listen for a new SW installing after page load
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // A new SW is waiting → user is on an older version.
              showUpdateBanner();
            }
          });
        });
      }).catch(() => {});

      // When the new SW installs and broadcasts SW_UPDATED (with its version),
      // auto-reload the page once per version. This is version-keyed so future
      // deploys still trigger a fresh reload — unlike keying on scriptURL, which
      // never changes and would only fire once ever.
      navigator.serviceWorker.addEventListener('message', ev => {
        if (!ev.data || ev.data.type !== 'SW_UPDATED') return;
        const ver = ev.data.version || 'unknown';
        const key = 'dce_sw_reloaded_' + ver;
        if (sessionStorage.getItem(key) === '1') {
          // Already reloaded for this version — just show the banner in case
          // the user did a soft in-tab navigation.
          showUpdateBanner();
          return;
        }
        sessionStorage.setItem(key, '1');
        // Small delay so any in-flight requests can settle.
        setTimeout(() => location.reload(), 250);
      });
    });
  }

  // ── Long-press context menu disable (R) ────────────────
  // Disable text/image callout on non-input elements for native feel.
  function disableCallout() {
    document.addEventListener('contextmenu', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT','TEXTAREA'].includes(tag)) return;
      if (e.target && e.target.isContentEditable) return;
      e.preventDefault();
    });
  }

  // ── Pull-to-refresh (M) ────────────────────────────
  // Enabled only on pages that declare data-pull-refresh="1" on <body>.
  // Triggers window.dceRefresh() if defined, else location.reload().
  function initPullToRefresh() {
    if (!document.body.dataset.pullRefresh) return;
    let startY = 0, pulling = false, dist = 0;
    const THRESHOLD = 70;

    const indicator = document.createElement('div');
    indicator.id = 'dce-ptr';
    indicator.innerHTML = '<div class="dce-ptr-spinner"></div>';
    document.body.appendChild(indicator);

    document.addEventListener('touchstart', (e) => {
      if (window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      pulling = true;
      dist = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0 && window.scrollY === 0) {
        const d = Math.min(dist, THRESHOLD * 1.6);
        indicator.style.transform = `translate(-50%, ${d - 40}px)`;
        indicator.style.opacity = String(Math.min(1, d / THRESHOLD));
        if (d >= THRESHOLD) indicator.classList.add('is-armed');
        else indicator.classList.remove('is-armed');
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!pulling) return;
      pulling = false;
      if (dist >= THRESHOLD) {
        indicator.classList.add('is-loading');
        haptic(12);
        setTimeout(() => {
          if (typeof window.dceRefresh === 'function') {
            Promise.resolve(window.dceRefresh())
              .then(() => showToast('Refreshed'))
              .catch(() => showToast('Refresh failed'))
              .finally(() => resetIndicator());
          } else {
            location.reload();
          }
        }, 120);
      } else {
        resetIndicator();
      }
    });

    function resetIndicator() {
      indicator.style.transform = '';
      indicator.style.opacity = '';
      indicator.classList.remove('is-armed');
      indicator.classList.remove('is-loading');
    }
  }

  // ── Toast (short-lived notice) ──────────────────────
  let toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById('dce-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dce-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-open'), 1400);
  }

  // ── Init ──────────────────────────────────────────────────────
  registerSW();
  disableCallout();

  function init() {
    if (!isMobile()) return;
    buildTabBar();
    buildShareBtn();
    initPullToRefresh();
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
