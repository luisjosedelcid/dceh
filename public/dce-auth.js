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
      .dce-admin-btn{position:fixed;bottom:18px;right:18px;z-index:9998;
        font-family:'Archivo',sans-serif;font-size:11px;font-weight:600;
        letter-spacing:0.12em;text-transform:uppercase;padding:10px 16px;
        border:1px solid #1b2642;background:#fff;color:#1b2642;cursor:pointer;
        border-radius:2px;box-shadow:0 4px 12px rgba(0,0,0,0.08);transition:all .2s}
      .dce-admin-btn:hover{background:#1b2642;color:#fff}
      .dce-admin-btn.is-admin{background:#1b2642;color:#b88b47;border-color:#1b2642}
      .dce-admin-btn.is-admin:hover{background:#fff;color:#1b2642}
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
      _btnEl.textContent = `${who} · Sign out`;
      _btnEl.title = 'Click to sign out of admin mode';
    } else {
      _btnEl.textContent = 'Admin login';
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
        if (confirm('Sign out of admin mode?')) { logout(); window.location.reload(); }
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
  function _autoMount() {
    if (document.body.dataset.dceAuth === 'manual') return;
    mountAdminButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoMount);
  } else {
    _autoMount();
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.dceAuth = {
    isAdmin, token, user, login, logout,
    onChange, openLoginModal, mountAdminButton, ensureAdmin,
    // For backwards-compat with code reading these directly:
    TOKEN_KEY, EXP_KEY, USER_KEY,
  };
})();
