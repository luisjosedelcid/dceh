// POST /api/admin-login
// Body: { email?: string, password: string }
// Response: { token, expiresAt, user: { email, displayName } } or { error }
//
// Multi-user flow:
//   1. If admin_users table has rows, expect { email, password } and bcrypt-verify.
//   2. If admin_users is empty, fall back to legacy ADMIN_PASSWORD env var
//      AND auto-seed Luis on first successful login (so the table is populated
//      from then on without requiring a manual SQL insert).

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { signToken } = require('./_admin-auth');
const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');

const SEED_EMAIL = 'luis@dceholdings.com';
const SEED_NAME  = 'Luis del Cid';

function timingSafeStrEq(a, b) {
  const ab = Buffer.from(String(a).padEnd(64, '\0').slice(0, 64));
  const bb = Buffer.from(String(b).padEnd(64, '\0').slice(0, 64));
  return crypto.timingSafeEqual(ab, bb) && a.length === b.length;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const password = (body && body.password) || '';
  const emailIn  = ((body && body.email) || '').trim().toLowerCase();

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password required' });
    return;
  }

  // ── Try admin_users table first ───────────────────────────
  let users = [];
  try {
    users = await sbSelect('admin_users', 'select=id,email,display_name,password_hash,is_active,role&is_active=eq.true');
  } catch (e) {
    // Table missing or other error — fall through to legacy mode
    users = [];
  }

  let matched = null;

  if (users.length > 0) {
    if (!emailIn) {
      await new Promise(r => setTimeout(r, 300));
      res.status(400).json({ error: 'Email and password required' });
      return;
    }
    const u = users.find(x => x.email.toLowerCase() === emailIn);
    if (u) {
      try {
        const ok = await bcrypt.compare(password, u.password_hash);
        if (ok) matched = u;
      } catch { matched = null; }
    }
  } else {
    // ── Legacy fallback ─ env-var password ────────────────────
    if (!ADMIN_PASSWORD) {
      res.status(500).json({ error: 'No admin user configured' });
      return;
    }
    if (timingSafeStrEq(password, ADMIN_PASSWORD)) {
      // Auto-seed Luis so subsequent logins go through admin_users.
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      try {
        const seeded = await sbInsert('admin_users', {
          email: SEED_EMAIL,
          display_name: SEED_NAME,
          password_hash: hash,
          is_active: true,
        });
        matched = Array.isArray(seeded) ? seeded[0] : seeded;
      } catch (e) {
        // Could not seed — still let them in this once
        matched = { email: SEED_EMAIL, display_name: SEED_NAME };
      }
    }
  }

  if (!matched) {
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: users.length > 0 ? 'Invalid email or password' : 'Invalid password' });
    return;
  }

  // Update last_login (best-effort)
  try {
    if (matched.id) {
      await sbUpdate('admin_users', `id=eq.${matched.id}`, { last_login: new Date().toISOString() });
    }
  } catch {}

  // Audit the login (best-effort)
  try {
    await sbInsert('report_audit', {
      actor_email: matched.email,
      action: 'login',
      detail: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 200) : null,
    });
  } catch {}

  const { token, expiresAt } = signToken(matched.email, ADMIN_TOKEN_SECRET);
  res.status(200).json({
    token,
    expiresAt,
    user: {
      email: matched.email,
      displayName: matched.display_name,
      role: matched.role || 'admin',
    },
  });
};
