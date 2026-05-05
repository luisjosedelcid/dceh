// POST /api/admin-login
// Body: { email: string, password: string }
// Response: { token, expiresAt, user: { email, displayName, role } } or { error }
//
// Authentication:
//   - admin_users table is the single source of truth (multi-user, bcrypt password hashes).
//   - The legacy ADMIN_PASSWORD env var fallback was removed on 2026-05-05.
//
// Rate limiting:
//   - Up to 5 failed attempts per (email) AND per (ip) in the last 15 minutes.
//   - On the 6th failed attempt within that window, the request is rejected with 429
//     for ~15 minutes, even before bcrypt is checked.
//   - Successful logins do not count toward the limit.

const bcrypt = require('bcryptjs');
const { signToken } = require('./_admin-auth');
const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');

const RATE_WINDOW_MIN  = 15;
const RATE_MAX_PER_KEY = 5;

function getClientIp(req) {
  // Vercel sets x-forwarded-for; first hop is the real client.
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  if (xff) return xff.split(',')[0].trim();
  const xri = (req.headers['x-real-ip'] || '').toString();
  if (xri) return xri.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function recordAttempt({ email, ip, success, userAgent }) {
  try {
    await sbInsert('login_attempts', {
      email: (email || '').toLowerCase().slice(0, 200),
      ip: String(ip || 'unknown').slice(0, 64),
      success: !!success,
      user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
    });
  } catch { /* best-effort */ }
}

async function isRateLimited({ email, ip }) {
  const sinceIso = new Date(Date.now() - RATE_WINDOW_MIN * 60 * 1000).toISOString();
  try {
    // Count failed attempts in the window for either the email or the IP.
    const emailEsc = encodeURIComponent((email || '').toLowerCase());
    const ipEsc    = encodeURIComponent(ip);
    const sinceEsc = encodeURIComponent(sinceIso);
    const q = `select=email,ip&success=eq.false&attempted_at=gte.${sinceEsc}&or=(email.eq.${emailEsc},ip.eq.${ipEsc})&limit=200`;
    const rows = await sbSelect('login_attempts', q);
    const byEmail = rows.filter(r => (r.email || '').toLowerCase() === (email || '').toLowerCase()).length;
    const byIp    = rows.filter(r => r.ip === ip).length;
    return byEmail >= RATE_MAX_PER_KEY || byIp >= RATE_MAX_PER_KEY;
  } catch {
    return false; // fail-open: don't lock everyone out if Supabase blips
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
  const ip       = getClientIp(req);
  const ua       = req.headers['user-agent'] || null;

  if (!emailIn || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  // ── Rate limit gate ───────────────────────────────────────
  if (await isRateLimited({ email: emailIn, ip })) {
    await recordAttempt({ email: emailIn, ip, success: false, userAgent: ua });
    res.setHeader('Retry-After', String(RATE_WINDOW_MIN * 60));
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }

  // ── Verify against admin_users ────────────────────────────
  let users = [];
  try {
    users = await sbSelect(
      'admin_users',
      `select=id,email,display_name,password_hash,is_active,role&is_active=eq.true&email=eq.${encodeURIComponent(emailIn)}&limit=1`
    );
  } catch (e) {
    res.status(500).json({ error: 'Auth service unavailable' });
    return;
  }

  let matched = null;
  if (users.length > 0) {
    const u = users[0];
    try {
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) matched = u;
    } catch { matched = null; }
  } else {
    // Burn cycles to keep timing similar to a real bcrypt comparison.
    try { await bcrypt.compare(password, '$2a$12$0123456789012345678901uMqQ8Pq8DqJ9k7Z1n5e3j5aZ2L9X6S'); } catch {}
  }

  if (!matched) {
    await recordAttempt({ email: emailIn, ip, success: false, userAgent: ua });
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // ── Success ───────────────────────────────────────────────
  await recordAttempt({ email: emailIn, ip, success: true, userAgent: ua });

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
      detail: ua ? String(ua).slice(0, 200) : null,
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
