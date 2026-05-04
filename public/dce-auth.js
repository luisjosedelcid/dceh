// ═══════════════════════════════════════════════════════════════════════
// DCE Holdings — Shared Admin Auth (global, cross-page, cross-tab)
// ═══════════════════════════════════════════════════════════════════════
// Single source of truth for admin authentication.
// Uses localStorage so the session persists across pages AND tabs.
// Exposes window.dceAuth with: isAdmin, token, user, login, logout,
// onChange, openLoginModal, mountAdminButton, ensureAdmin.
//
// USAGE in any page:
//   <script src="/dce-auth.js" defer></script>
//   then call: dceAuth.mountAdminButton('#admin-slot')   // optional widget
//   or just:    if (dceAuth.isAdmin()) { ... }
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Storage keys (localStorage; survives reload + cross-tab) ──────────
  const TOKEN_KEY = 'dce_admin_token';
  const EXP_KEY   = 'dce_admin_token_exp';
  const USER_KEY  = 'dce_admin_user';

  // Legacy migration: if old sessionStorage values exist, copy to localStorage
  try {
    if (!localStorage.getItem(TOKEN_KEY) && sessionStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, sessionStorage.getItem(TOKEN_KEY));
      const e1 = sessionStorage.getItem('dce_admin_token_exp') || sessionStorage.getItem('dce_admin_exp');
      if (e1) localStorage.setItem(EXP_KEY, e1);
      const u  = sessionStorage.getItem(USER_KEY);
      if (u)  localStorage.setItem(USER_KEY, u);
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem('dce_admin_token_exp');
      sessionStorage.removeItem('dce_admin_exp');
      sessionStorage.removeItem(USER_KEY);
    }
  } catch (e) { /* ignore */ }

  function isAdmin() {
    const tok = localStorage.getItem(TOKEN_KEY);
    const exp = parseInt(localStorage.getItem(EXP_KEY) || '0', 10);
    if (!tok || !exp) return false;
    if (exp < Math.floor(Date.now() / 1000)) {
      _clear();
      return false;
    }
    return true;
  }

  function token() {
    return isAdmin() ? localStorage.getItem(TOKEN_KEY) : null;
  }

  function user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  }

  function role() {
    const u = user();
    return (u && u.role) ? u.role : null;
  }

  function hasRole(allowed) {
    if (!isAdmin()) return false;
    const r = role();
    if (!Array.isArray(allowed) || allowed.length === 0) return true;
    if (allowed.includes('any')) return true;
    // Backwards-compat: legacy sessions without role default to admin
    return allowed.includes(r || 'admin');
  }

  function _clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXP_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function logout() {
    _clear();
    _emit();
    _refreshButton();
  }

  async function login(emailOrPassword, maybePassword) {
    // Backwards-compat: accept (password) OR (email, password)
    let email = '', password = '';
    if (maybePassword === undefined) {
      password = emailOrPassword || '';
    } else {
      email = (emailOrPassword || '').trim();
      password = maybePassword || '';
    }
    if (!password) return { ok: false, error: 'Password required' };

    try {
      const r = await fetch('/api/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: data.error || `HTTP ${r.status}` };

      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(EXP_KEY, String(data.expiresAt));
      if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      _emit();
      _refreshButton();
      return { ok: true, user: data.user || null };
    } catch (e) {
      return { ok: false, error: 'Network error' };
    }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────
  const _subs = new Set();
  function onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }
  function _emit() { _subs.forEach(cb => { try { cb(isAdmin()); } catch {} }); }

  // Cross-tab sync
  window.addEventListener('storage', (e) => {
    if ([TOKEN_KEY, EXP_KEY, USER_KEY].includes(e.key)) {
      _emit();
      _refreshButton();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // UI: floating admin button + login modal (auto-injected on every page)
  // ═══════════════════════════════════════════════════════════════════════
  let _btnEl = null;
  let _modalEl = null;

  function _injectStyles() {
    if (document.getElementById('dce-auth-styles')) return;
    const css = `
      .dce-admin-btn{font-family:'Archivo',sans-serif;font-size:10px;font-weight:600;
        letter-spacing:0.14em;text-transform:uppercase;padding:6px 12px;
        border:1px solid rgba(255,255,255,0.45);background:transparent;color:#fff;
        cursor:pointer;border-radius:2px;transition:all .2s;line-height:1.2}
      .dce-admin-btn:hover{background:rgba(255,255,255,0.12);border-color:#fff}
      .dce-admin-btn.is-admin{background:#b88b47;color:#1b2642;border-color:#b88b47}
      .dce-admin-btn.is-admin:hover{background:#d4aa6a;border-color:#d4aa6a}
      /* Inline placement (preferred): inside nav */
      .hnav .dce-admin-btn,header .dce-admin-btn{margin-left:8px}
      /* Allow nav to wrap so Search + Sign Out don't overflow on narrow viewports */
      .hnav{flex-wrap:wrap !important;row-gap:6px;align-items:center !important}
      /* Link padding for grouped 7-item nav */
      .hnav a, .hnav .dce-group-trigger{padding:8px 13px !important;letter-spacing:0.14em !important}
      /* ===== Dropdown nav groups (Monitor / Pipeline / Decisions / Intel) ===== */
      .dce-group{position:relative;display:inline-flex;align-items:center}
      .dce-group-trigger{font-family:inherit;font-size:inherit;font-weight:inherit;
        letter-spacing:0.14em;text-transform:uppercase;color:inherit;background:transparent;
        border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:inherit;
        padding:8px 13px;border-radius:2px;transition:color .15s, background .15s}
      .dce-group-trigger:hover{color:#b88b47 !important;background:rgba(255,255,255,0.05)}
      .dce-group-trigger .dce-caret{font-size:8px;opacity:0.7;transform:translateY(1px);transition:transform .15s}
      .dce-group.open .dce-group-trigger .dce-caret{transform:translateY(1px) rotate(180deg)}
      /* Active group (current page belongs to this group) */
      .dce-group.is-active .dce-group-trigger{color:#b88b47 !important;border:1px solid #b88b47;padding:7px 12px}
      .dce-dropdown{display:none;position:absolute;top:calc(100% + 6px);left:0;
        background:#fff;color:#1b2642;min-width:240px;
        border:1px solid #d8d8d8;border-radius:3px;
        box-shadow:0 8px 28px rgba(0,0,0,0.20);z-index:200;overflow:hidden}
      .dce-group.open .dce-dropdown{display:block}
      .dce-dropdown a{display:block !important;padding:11px 16px !important;color:#1b2642 !important;
        text-decoration:none;font-size:11px;font-weight:500;letter-spacing:0.10em !important;
        text-transform:none;border-bottom:1px solid #f0f0f0;line-height:1.4;background:transparent !important}
      .dce-dropdown a:last-child{border-bottom:none}
      .dce-dropdown a:hover{background:#fbf6ee !important;color:#b88b47 !important}
      .dce-dropdown a.active, .dce-dropdown a[aria-current="page"]{
        background:#fbf6ee !important;color:#b88b47 !important;font-weight:600}
      .dce-dropdown a .dce-sub-desc{display:block;font-size:10px;color:#888;
        letter-spacing:0;margin-top:3px;font-weight:400;text-transform:none}
      .dce-dropdown a:hover .dce-sub-desc{color:#a87a3a}
      @media (max-width: 720px){
        .dce-dropdown{position:static;min-width:0;width:100%;box-shadow:none;border:none;
          background:rgba(255,255,255,0.06);margin-top:0}
        .dce-dropdown a{color:#fff !important;background:transparent !important;
          border-bottom-color:rgba(255,255,255,0.08) !important}
        .dce-dropdown a:hover, .dce-dropdown a.active{background:rgba(184,139,71,0.15) !important;color:#b88b47 !important}
        .dce-dropdown a .dce-sub-desc{color:#cfd6e6}
      }
      /* Fixed fallback: only when not mounted inside the header */
      .dce-admin-btn.dce-floating{position:fixed;top:14px;right:18px;z-index:9998}
      @media (max-width: 720px){ .dce-admin-btn.dce-floating{top:10px;right:12px;padding:5px 10px;font-size:9px} }
      .dce-auth-modal{display:none;position:fixed;inset:0;background:rgba(13,13,13,0.55);
        z-index:9999;align-items:center;justify-content:center;font-family:'Inter',sans-serif}
      .dce-auth-modal.show{display:flex}
      .dce-auth-card{background:#fff;width:380px;max-width:92vw;padding:28px 28px 24px;
        border-radius:4px;box-shadow:0 18px 48px rgba(0,0,0,0.25)}
      .dce-auth-card h3{font-family:'Archivo',sans-serif;font-size:13px;font-weight:600;
        letter-spacing:0.18em;text-transform:uppercase;color:#1b2642;margin:0 0 18px;
        padding-bottom:12px;border-bottom:1px solid #e6e6e6}
      .dce-auth-card label{display:block;font-size:10px;font-weight:600;letter-spacing:0.12em;
        text-transform:uppercase;color:#606060;margin-bottom:6px;margin-top:14px}
      .dce-auth-card input{width:100%;padding:10px 12px;border:1px solid #c3c7d2;
        font-family:inherit;font-size:13px;box-sizing:border-box;border-radius:2px}
      .dce-auth-card input:focus{outline:none;border-color:#b88b47}
      .dce-auth-card .err{color:#a02a1f;font-size:11px;min-height:16px;margin-top:10px}
      .dce-auth-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
      .dce-auth-actions button{font-family:'Archivo',sans-serif;font-size:11px;font-weight:600;
        letter-spacing:0.12em;text-transform:uppercase;padding:9px 16px;cursor:pointer;
        border-radius:2px;border:1px solid transparent}
      .dce-auth-actions .ghost{background:transparent;color:#606060;border-color:#c3c7d2}
      .dce-auth-actions .ghost:hover{color:#1b2642;border-color:#1b2642}
      .dce-auth-actions .primary{background:#1b2642;color:#fff}
      .dce-auth-actions .primary:hover{background:#0f1830}
    `;
    const style = document.createElement('style');
    style.id = 'dce-auth-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function _ensureModal() {
    if (_modalEl) return _modalEl;
    _injectStyles();
    const wrap = document.createElement('div');
    wrap.className = 'dce-auth-modal';
    wrap.innerHTML = `
      <div class="dce-auth-card" role="dialog" aria-modal="true" aria-label="Admin login">
        <h3>Admin Sign-In</h3>
        <label>Email (optional)</label>
        <input type="email" autocomplete="username" data-dce-email placeholder="luis@dceholdings.com">
        <label>Password</label>
        <input type="password" autocomplete="current-password" data-dce-pw>
        <div class="err" data-dce-err></div>
        <div class="dce-auth-actions">
          <button type="button" class="ghost" data-dce-cancel>Cancel</button>
          <button type="button" class="primary" data-dce-submit>Sign in</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    _modalEl = wrap;

    const emailEl = wrap.querySelector('[data-dce-email]');
    const pwEl    = wrap.querySelector('[data-dce-pw]');
    const errEl   = wrap.querySelector('[data-dce-err]');

    wrap.addEventListener('click', e => { if (e.target === wrap) _hideModal(); });
    wrap.querySelector('[data-dce-cancel]').addEventListener('click', _hideModal);
    emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') pwEl.focus(); });
    pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') wrap.querySelector('[data-dce-submit]').click(); });
    wrap.querySelector('[data-dce-submit]').addEventListener('click', async () => {
      errEl.textContent = 'Signing in…';
      errEl.style.color = '#606060';
      const res = await login(emailEl.value, pwEl.value);
      if (res.ok) {
        _hideModal();
        // Re-render any admin-aware UI on the page by reloading
        window.location.reload();
      } else {
        errEl.textContent = res.error || 'Login failed';
        errEl.style.color = '#a02a1f';
      }
    });

    return wrap;
  }

  function _showModal() {
    _ensureModal();
    _modalEl.querySelector('[data-dce-err]').textContent = '';
    _modalEl.querySelector('[data-dce-pw]').value = '';
    _modalEl.classList.add('show');
    setTimeout(() => _modalEl.querySelector('[data-dce-pw]').focus(), 60);
  }
  function _hideModal() { if (_modalEl) _modalEl.classList.remove('show'); }

  function openLoginModal() { _showModal(); }

  function _refreshButton() {
    if (!_btnEl) return;
    const adm = isAdmin();
    _btnEl.classList.toggle('is-admin', adm);
    if (adm) {
      const u = user();
      const who = u && u.displayName ? u.displayName.split(' ')[0] : 'Admin';
      _btnEl.textContent = `Sign out`;
      _btnEl.title = `Signed in as ${who} — click to sign out`;
    } else {
      _btnEl.textContent = 'Sign in';
      _btnEl.title = 'Sign in as admin to edit alerts, upload files, etc.';
    }
  }

  function mountAdminButton(target) {
    _injectStyles();
    if (_btnEl) return _btnEl;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dce-admin-btn';
    btn.addEventListener('click', () => {
      if (isAdmin()) {
        if (confirm('Sign out and return to login?')) {
          logout();
          // Also clear the legacy gate flag so user is fully logged out
          try { sessionStorage.removeItem('dce_auth'); } catch {}
          // Send them back to the landing/gate page
          window.location.href = '/';
        }
      } else {
        _showModal();
      }
    });
    if (target) {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (el) el.appendChild(btn);
      else document.body.appendChild(btn);
    } else {
      document.body.appendChild(btn);
    }
    _btnEl = btn;
    _refreshButton();
    return btn;
  }

  // Returns a promise that resolves once admin is authenticated.
  // Auto-opens the modal if not already.
  function ensureAdmin() {
    if (isAdmin()) return Promise.resolve(true);
    return new Promise((resolve) => {
      _showModal();
      const off = onChange((adm) => { if (adm) { off(); resolve(true); } });
    });
  }

  // ── Auto-mount button on every page (unless opt-out) ─────────────────
  function _findNavTarget() {
    // 1. Standard nav (.hnav on most pages)
    const hnav = document.querySelector('.hnav');
    if (hnav) return hnav;
    // 2. Home page: container that holds links to /research.html or /reporting.html
    const header = document.querySelector('header');
    if (header) {
      const divs = header.querySelectorAll('div');
      for (const div of divs) {
        if (div.querySelector('a[href="/reporting.html"]') || div.querySelector('a[href="/research.html"]')) {
          return div;
        }
      }
    }
    return null;
  }

  // ── Nav grouping: collapse 13 flat links into 7 items with 4 dropdowns ────
  // The grouped order is: Home · Monitor ▾ · Pipeline ▾ · Decisions ▾ · Intel ▾ · Data Room · Reporting
  const NAV_GROUPS = [
    { id:'home', label:'Home', href:'/', single:true },
    { id:'monitor', label:'Monitor', items:[
      { href:'/cockpit.html',     label:'Cockpit',     desc:'Daily CIO screen — gates, decisiones, eventos' },
      { href:'/portfolio.html',   label:'Portfolio',   desc:'P&L live, posiciones, allocation' },
      { href:'/performance.html', label:'Performance', desc:'NAV histórico vs IWQU.L, transactions' },
    ]},
    { id:'pipeline', label:'Pipeline', items:[
      { href:'/screener.html',    label:'Find',     desc:'Idea generation — superinvestors, sector screener' },
      { href:'/research.html',    label:'Workflow', desc:'Kanban de tesis en investigación' },
      { href:'/universe.html',    label:'Universe', desc:'Columbia framework — EPV, IRR, MoS' },
    ]},
    { id:'decisions', label:'Decisions', items:[
      { href:'/journal.html',     label:'Journal',     desc:'Decision journal — buy/sell con thesis' },
      { href:'/premortem.html',   label:'Pre-mortem',  desc:'Watch failure modes · manage' },
    ]},
    { id:'research', label:'Research', items:[
      { href:'/news.html',        label:'News',     desc:'AI news scanner (Claude)' },
      { href:'/calendar.html',    label:'Calendar', desc:'Earnings dates de la cobertura' },
      { href:'/study.html',       label:'Study',    desc:'Sector deep-dives + megatrends' },
    ]},
    { id:'reporting', label:'Reporting', href:'/reporting.html', single:true },
    { id:'dataroom',  label:'Data Room', href:'/dataroom.html',  single:true },
  ];

  function _normalizePath(p) {
    if (!p) return '/';
    try { p = new URL(p, window.location.origin).pathname; } catch {}
    if (p === '' || p === '/index.html') p = '/';
    return p;
  }

  function _groupNav(hnav) {
    if (!hnav || hnav.dataset.dceGrouped === '1') return;
    // Collect existing flat links keyed by normalized href so we can preserve
    // attributes (target, classes) and detect the active page.
    const existingByHref = new Map();
    Array.from(hnav.querySelectorAll('a')).forEach(a => {
      const h = _normalizePath(a.getAttribute('href'));
      if (!existingByHref.has(h)) existingByHref.set(h, a);
    });
    const here = _normalizePath(window.location.pathname);

    // Build new content
    const frag = document.createDocumentFragment();
    NAV_GROUPS.forEach(group => {
      if (group.single) {
        const a = document.createElement('a');
        a.href = group.href;
        a.textContent = group.label;
        if (_normalizePath(group.href) === here) a.classList.add('active');
        frag.appendChild(a);
        return;
      }
      // Dropdown group
      const wrap = document.createElement('div');
      wrap.className = 'dce-group';
      wrap.dataset.group = group.id;
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'dce-group-trigger';
      trigger.setAttribute('aria-haspopup','true');
      trigger.setAttribute('aria-expanded','false');
      trigger.innerHTML = `${group.label} <span class="dce-caret">▾</span>`;
      const dd = document.createElement('div');
      dd.className = 'dce-dropdown';
      dd.setAttribute('role','menu');
      let groupActive = false;
      group.items.forEach(it => {
        const a = document.createElement('a');
        a.href = it.href;
        a.setAttribute('role','menuitem');
        a.innerHTML = `${it.label}<span class="dce-sub-desc">${it.desc}</span>`;
        if (_normalizePath(it.href) === here) { a.classList.add('active'); a.setAttribute('aria-current','page'); groupActive = true; }
        dd.appendChild(a);
      });
      if (groupActive) wrap.classList.add('is-active');
      wrap.appendChild(trigger);
      wrap.appendChild(dd);
      // Open/close on hover (desktop) and click (touch / keyboard)
      let hideTimer = null;
      const open  = () => { clearTimeout(hideTimer); _closeAllGroups(wrap); wrap.classList.add('open'); trigger.setAttribute('aria-expanded','true'); };
      const close = () => { wrap.classList.remove('open'); trigger.setAttribute('aria-expanded','false'); };
      const closeSoon = () => { hideTimer = setTimeout(close, 140); };
      wrap.addEventListener('mouseenter', open);
      wrap.addEventListener('mouseleave', closeSoon);
      trigger.addEventListener('click', (e) => { e.preventDefault(); wrap.classList.contains('open') ? close() : open(); });
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); const first = dd.querySelector('a'); first && first.focus(); }
        if (e.key === 'Escape') { close(); trigger.focus(); }
      });
      dd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } });
      frag.appendChild(wrap);
    });

    // Before replacing, capture the typography of an existing <a> so the new
    // <button> triggers can match it exactly (each page defines its own .hnav a).
    // Prefer a non-active <a> as sample so we don't inherit gold/active styles.
    const sample = hnav.querySelector('a:not(.active):not([aria-current="page"])') || hnav.querySelector('a');
    let sampleStyle = null;
    if (sample) {
      const cs = getComputedStyle(sample);
      sampleStyle = {
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily,
      };
    }

    // Replace the existing flat links (keep any non-<a> children like Search trigger or Sign Out — they're appended later).
    Array.from(hnav.querySelectorAll('a, .dce-group')).forEach(el => el.remove());
    hnav.insertBefore(frag, hnav.firstChild);
    hnav.dataset.dceGrouped = '1';

    // Apply captured typography to all new <button> triggers so they match
    // the exact look of the surrounding <a> links (color, weight, size, family).
    if (sampleStyle) {
      hnav.querySelectorAll('.dce-group-trigger').forEach(btn => {
        btn.style.color = sampleStyle.color;
        btn.style.fontSize = sampleStyle.fontSize;
        btn.style.fontWeight = sampleStyle.fontWeight;
        btn.style.fontFamily = sampleStyle.fontFamily;
      });
    }

    // Click outside closes any open dropdown
    if (!document.body.dataset.dceNavGlobalListener) {
      document.body.dataset.dceNavGlobalListener = '1';
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.dce-group')) _closeAllGroups();
      });
    }
  }

  function _closeAllGroups(except) {
    document.querySelectorAll('.dce-group.open').forEach(g => {
      if (g !== except) {
        g.classList.remove('open');
        const t = g.querySelector('.dce-group-trigger');
        if (t) t.setAttribute('aria-expanded','false');
      }
    });
  }

  function _autoMount() {
    // Always inject shared CSS (nav padding override, modal styles), even in 'manual' mode.
    // Manual mode only opts out of mounting the Sign Out button — pages that handle auth
    // themselves (e.g. reporting.html) still need the canonical nav styling.
    _injectStyles();
    // Always group the nav (works for both 'manual' and auto-mount pages)
    const hnavForGroup = document.querySelector('.hnav');
    if (hnavForGroup) _groupNav(hnavForGroup);
    if (document.body.dataset.dceAuth === 'manual') return;
    const target = _findNavTarget();
    if (target) {
      mountAdminButton(target);
      // search.js may run after us and append its trigger AFTER the sign-out button.
      // Re-anchor to the end on the next tick so order is: [links] [Search] [Sign Out].
      const reorderToEnd = () => {
        if (_btnEl && _btnEl.parentElement) {
          _btnEl.parentElement.appendChild(_btnEl);
        }
      };
      setTimeout(reorderToEnd, 0);
      setTimeout(reorderToEnd, 200);
    } else {
      // Fallback: floating top-right (legacy behavior)
      const btn = mountAdminButton();
      if (btn) btn.classList.add('dce-floating');
    }
    _applyRoleVisibility();
  }

  // ── Role-based UI hiding ────────────────────────────────────────────
  // Admin-only routes: hidden from nav for non-admin authenticated users.
  // Backwards-compat: sessions without role are treated as admin.
  const ADMIN_ONLY_HREFS = ['/reporting.html', '/reporting', '/performance.html', '/performance', '/premortem.html', '/premortem'];
  function _applyRoleVisibility() {
    const u = user();
    if (!u) return; // not signed in — leave nav alone
    const r = (u && u.role) ? u.role : 'admin';
    if (r === 'admin') return;
    try {
      const sel = ADMIN_ONLY_HREFS.map(h => `a[href="${h}"]`).join(',');
      document.querySelectorAll(sel).forEach(a => { a.style.display = 'none'; });
    } catch (e) { /* ignore */ }
  }
  // Re-apply on cross-tab login/logout
  onChange(_applyRoleVisibility);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoMount);
  } else {
    _autoMount();
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.dceAuth = {
    isAdmin, token, user, role, hasRole, login, logout,
    onChange, openLoginModal, mountAdminButton, ensureAdmin,
    // For backwards-compat with code reading these directly:
    TOKEN_KEY, EXP_KEY, USER_KEY,
  };
})();
