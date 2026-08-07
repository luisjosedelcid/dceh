// /api/admin/users
//
// Admin-only user management for DCE Holdings.
//
//   GET    /api/admin/users                 → list all users
//   POST   /api/admin/users                 → create user
//                                             body: { email, display_name, role, password }
//   PATCH  /api/admin/users?email=X         → update display_name / role / is_active
//                                             body: any subset of { display_name, role, is_active }
//   POST   /api/admin/users?action=password&email=X
//                                             → set new password
//                                             body: { password }
//   POST   /api/admin/users?action=reset_link&email=X
//                                             → generate password-reset link (returns URL+token)
//                                             body: {} (Resend sending wired in a follow-up)
//   DELETE /api/admin/users?email=X         → soft-delete (is_active=false)
//
// Self-protection rules:
//   - Admin cannot deactivate or demote themselves.
//   - Admin cannot delete themselves.
//   - At least one active admin must remain.

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sbSelect, sbInsert, sbUpdate } = require('../_supabase');
const { requireCapability } = require('../_require-capability');

const VALID_ROLES = ['admin', 'cio', 'analyst', 'viewer'];
// Roles considered "privileged" — must always have ≥1 active user across them.
// 'admin' is legacy (pre-RBAC); 'cio' is the new privileged role.
const PRIVILEGED_ROLES = ['admin', 'cio'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_HOURS = 24;

function audit(actor_email, action, target_email, detail) {
  // Re-uses existing report_audit table to avoid schema sprawl.
  return sbInsert('report_audit', {
    actor_email,
    action,
    folder: 'users',
    filename: target_email || null,
    detail: detail || null,
  }).catch(() => { /* best-effort */ });
}

async function listUsers() {
  const rows = await sbSelect(
    'admin_users',
    'select=id,email,display_name,role,is_active,created_at,last_login&order=created_at.desc'
  );
  return rows;
}

async function getUserByEmail(email) {
  const rows = await sbSelect(
    'admin_users',
    `select=id,email,display_name,role,is_active&email=eq.${encodeURIComponent(email)}&limit=1`
  );
  return rows[0] || null;
}

async function countActiveAdmins() {
  // Counts active users with any privileged role (admin OR cio).
  const inList = PRIVILEGED_ROLES.map((r) => `"${r}"`).join(',');
  const rows = await sbSelect(
    'admin_users',
    `select=email&role=in.(${inList})&is_active=eq.true&limit=50`
  );
  return rows.length;
}

async function createUser({ email, display_name, role, password }, actor) {
  if (!EMAIL_RE.test(email)) throw httpErr(400, 'Invalid email');
  if (!display_name || display_name.length < 2) throw httpErr(400, 'display_name required (min 2 chars)');
  if (!VALID_ROLES.includes(role)) throw httpErr(400, `role must be one of: ${VALID_ROLES.join(', ')}`);
  if (!password || password.length < 8) throw httpErr(400, 'Password must be ≥ 8 chars');

  const existing = await getUserByEmail(email);
  if (existing) throw httpErr(409, 'User with this email already exists');

  const password_hash = await bcrypt.hash(password, 10);
  const inserted = await sbInsert('admin_users', {
    email: email.toLowerCase(),
    display_name,
    role,
    password_hash,
    is_active: true,
  });

  await audit(actor, 'user.create', email.toLowerCase(),
              `role=${role}, name="${display_name}"`);
  const u = Array.isArray(inserted) ? inserted[0] : inserted;
  return {
    id: u.id, email: u.email, display_name: u.display_name,
    role: u.role, is_active: u.is_active,
  };
}

async function updateUser({ email, patch, actor, actorRole }) {
  email = String(email || '').toLowerCase();
  const target = await getUserByEmail(email);
  if (!target) throw httpErr(404, 'User not found');

  const update = {};
  const auditParts = [];

  if (typeof patch.display_name === 'string') {
    if (patch.display_name.length < 2) throw httpErr(400, 'display_name min 2 chars');
    update.display_name = patch.display_name;
    auditParts.push(`name="${patch.display_name}"`);
  }
  if (typeof patch.role === 'string') {
    if (!VALID_ROLES.includes(patch.role)) {
      throw httpErr(400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    // Self-protection: privileged user (admin/cio) can't demote themselves
    if (actor === email && PRIVILEGED_ROLES.includes(target.role) && !PRIVILEGED_ROLES.includes(patch.role)) {
      throw httpErr(403, 'Cannot demote yourself from privileged role');
    }
    // If demoting a privileged user, make sure ≥1 privileged user remains
    if (PRIVILEGED_ROLES.includes(target.role) && !PRIVILEGED_ROLES.includes(patch.role)) {
      const admins = await countActiveAdmins();
      if (admins <= 1) throw httpErr(403, 'At least one active CIO (or legacy admin) must remain');
    }
    update.role = patch.role;
    auditParts.push(`role=${patch.role}`);
  }
  if (typeof patch.is_active === 'boolean') {
    if (actor === email && patch.is_active === false) {
      throw httpErr(403, 'Cannot deactivate yourself');
    }
    if (PRIVILEGED_ROLES.includes(target.role) && patch.is_active === false) {
      const admins = await countActiveAdmins();
      if (admins <= 1) throw httpErr(403, 'At least one active CIO (or legacy admin) must remain');
    }
    update.is_active = patch.is_active;
    auditParts.push(`is_active=${patch.is_active}`);
  }

  if (Object.keys(update).length === 0) {
    throw httpErr(400, 'No valid fields to update (display_name | role | is_active)');
  }

  const updated = await sbUpdate('admin_users', `email=eq.${encodeURIComponent(email)}`, update);
  await audit(actor, 'user.update', email, auditParts.join(', '));
  const u = Array.isArray(updated) ? updated[0] : updated;
  return {
    id: u.id, email: u.email, display_name: u.display_name,
    role: u.role, is_active: u.is_active,
  };
}

async function setPassword({ email, password, actor }) {
  email = String(email || '').toLowerCase();
  const target = await getUserByEmail(email);
  if (!target) throw httpErr(404, 'User not found');
  if (!password || password.length < 8) throw httpErr(400, 'Password must be ≥ 8 chars');

  const password_hash = await bcrypt.hash(password, 10);
  await sbUpdate('admin_users', `email=eq.${encodeURIComponent(email)}`, { password_hash });
  await audit(actor, 'user.password_reset', email, 'manual reset by admin');
  return { ok: true };
}

async function generateResetLink({ email, actor, baseUrl }) {
  email = String(email || '').toLowerCase();
  const target = await getUserByEmail(email);
  if (!target) throw httpErr(404, 'User not found');

  // Token: <email_b64>.<expiresAt>.<sig>
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) throw httpErr(500, 'ADMIN_TOKEN_SECRET not set');
  const expiresAt = Math.floor(Date.now() / 1000) + RESET_TTL_HOURS * 3600;
  const emailB64 = Buffer.from(email).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = `reset.${expiresAt}.${emailB64}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = `${payload}.${sig}`;
  const url = `${baseUrl}/reset-password.html?token=${encodeURIComponent(token)}`;

  await audit(actor, 'user.reset_link_generated', email, `expires in ${RESET_TTL_HOURS}h`);
  return { ok: true, reset_url: url, expires_in_hours: RESET_TTL_HOURS,
           note: 'Email delivery via Resend not enabled yet — copy this link manually.' };
}

async function deactivateUser({ email, actor }) {
  email = String(email || '').toLowerCase();
  const target = await getUserByEmail(email);
  if (!target) throw httpErr(404, 'User not found');
  if (actor === email) throw httpErr(403, 'Cannot deactivate yourself');
  if (target.role === 'admin') {
    const admins = await countActiveAdmins();
    if (admins <= 1) throw httpErr(403, 'At least one active admin must remain');
  }
  await sbUpdate('admin_users', `email=eq.${encodeURIComponent(email)}`,
                  { is_active: false });
  await audit(actor, 'user.deactivate', email, null);
  return { ok: true };
}

function httpErr(status, error) {
  const e = new Error(error);
  e.statusCode = status;
  return e;
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
    const auth = await requireCapability(req, 'US-01');
    if (!auth.ok) {
      res.statusCode = auth.status;
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    const actor = auth.user.email;

    const url = new URL(req.url, 'http://x');
    const email = url.searchParams.get('email');
    const action = url.searchParams.get('action');

    if (req.method === 'GET') {
      const items = await listUsers();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, items }));
      return;
    }

    if (req.method === 'POST' && !action) {
      const body = await readJson(req);
      const created = await createUser(body, actor);
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, user: created }));
      return;
    }

    if (req.method === 'POST' && action === 'password') {
      const body = await readJson(req);
      await setPassword({ email, password: body.password, actor });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && action === 'reset_link') {
      const protocol = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
      const host = (req.headers['x-forwarded-host'] || req.headers.host || 'www.dceholdings.app').toString();
      const baseUrl = `${protocol}://${host}`;
      const out = await generateResetLink({ email, actor, baseUrl });
      res.statusCode = 200;
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = await updateUser({ email, patch: body, actor, actorRole: auth.user.role });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, user: updated }));
      return;
    }

    if (req.method === 'DELETE') {
      await deactivateUser({ email, actor });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    const code = e.statusCode || 500;
    if (code >= 500) console.error('admin/users error:', e);
    res.statusCode = code;
    res.end(JSON.stringify({ error: e.message || 'Internal error' }));
  }
};
