// /api/me — self-service endpoint. Any authenticated active user can use it.
//
//   GET    /api/me                      → current user profile
//   PATCH  /api/me                      → update own display_name and/or job_title
//                                         body: { display_name?, job_title? }
//   POST   /api/me?action=password      → change own password
//                                         body: { current_password, new_password }
//
// Notes:
//   - Role and is_active are NEVER mutable here (admin-only via /api/admin/users).
//   - Password change requires current_password verification.

'use strict';

const bcrypt = require('bcryptjs');
const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');
const { requireCapability, loadCapabilitiesForUser } = require('./_require-capability');

function audit(actor_email, action, detail) {
  return sbInsert('report_audit', {
    actor_email,
    action,
    folder: 'users',
    filename: actor_email,
    detail: detail || null,
  }).catch(() => {});
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    const auth = await requireCapability(req, 'AU-04');
    if (!auth.ok) {
      res.statusCode = auth.status;
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    const me = auth.user; // { email, role, displayName }

    if (req.method === 'GET') {
      // Return fresh row (last_login etc.) + capabilities array for UI show/hide.
      const [rows, capsResult] = await Promise.all([
        sbSelect(
          'admin_users',
          `select=email,display_name,job_title,role,is_active,created_at,last_login&email=eq.${encodeURIComponent(me.email)}&limit=1`
        ),
        loadCapabilitiesForUser(req),
      ]);
      const capabilities = capsResult.ok ? capsResult.capabilities : [];
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, user: rows[0] || me, capabilities }));
      return;
    }

    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const patch = {};
      const auditParts = [];

      if (body.display_name !== undefined) {
        const display_name = (body.display_name || '').trim();
        if (display_name.length < 2) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'display_name min 2 chars' }));
          return;
        }
        patch.display_name = display_name;
        auditParts.push(`name="${display_name}"`);
      }

      if (body.job_title !== undefined) {
        const raw = (body.job_title == null ? '' : String(body.job_title)).trim();
        if (raw.length > 120) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'job_title max 120 chars' }));
          return;
        }
        patch.job_title = raw.length ? raw : null;
        auditParts.push(`job_title="${patch.job_title || ''}"`);
      }

      if (Object.keys(patch).length === 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'No fields to update (display_name, job_title)' }));
        return;
      }

      await sbUpdate('admin_users', `email=eq.${encodeURIComponent(me.email)}`, patch);
      await audit(me.email, 'user.self_update', auditParts.join(' '));
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, user: { email: me.email, ...patch } }));
      return;
    }

    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.searchParams.get('action') === 'password') {
      const body = await readJson(req);
      const current_password = body.current_password || '';
      const new_password = body.new_password || '';
      if (!current_password || !new_password) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'current_password and new_password are required' }));
        return;
      }
      if (new_password.length < 8) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'new_password must be ≥ 8 chars' }));
        return;
      }
      // Verify current
      const rows = await sbSelect(
        'admin_users',
        `select=password_hash,is_active&email=eq.${encodeURIComponent(me.email)}&limit=1`
      );
      const row = rows[0];
      if (!row || !row.is_active) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'User not active' }));
        return;
      }
      const ok = await bcrypt.compare(current_password, row.password_hash);
      if (!ok) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Current password incorrect' }));
        return;
      }
      const hash = await bcrypt.hash(new_password, 10);
      await sbUpdate('admin_users', `email=eq.${encodeURIComponent(me.email)}`,
                      { password_hash: hash });
      await audit(me.email, 'user.self_password_change', null);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    console.error('/api/me error:', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message || 'Internal error' }));
  }
};
