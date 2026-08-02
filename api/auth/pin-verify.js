// POST /api/auth/pin-verify
// Body: { email, pin }
// No auth required (this is the login endpoint itself)
// Returns: { token, expiresAt, email, role, displayName }
//
// Rate limiting: 5 failed attempts → 15 min lockout.

const bcrypt = require('bcryptjs');
const { signToken } = require('../_admin-auth');
const { sbSelect, sbUpdate } = require('../_supabase');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = String(body.email || '').toLowerCase();
  const pin = String(body.pin || '');

  if (!email || !/^\d{6}$/.test(pin)) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }

  // Look up PIN row + user in parallel
  const [pinRows, userRows] = await Promise.all([
    sbSelect(
      'admin_user_pins',
      `select=email,pin_hash,failed_attempts,locked_until&email=eq.${encodeURIComponent(email)}&limit=1`
    ),
    sbSelect(
      'admin_users',
      `select=email,display_name,role,is_active&email=eq.${encodeURIComponent(email)}&is_active=eq.true&limit=1`
    ),
  ]);

  if (!pinRows.length || !userRows.length) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const pinRow = pinRows[0];
  const user = userRows[0];

  // Check lockout
  if (pinRow.locked_until && new Date(pinRow.locked_until).getTime() > Date.now()) {
    const remainingSec = Math.ceil((new Date(pinRow.locked_until).getTime() - Date.now()) / 1000);
    res.status(429).json({ error: `Locked. Try again in ${Math.ceil(remainingSec/60)} min` });
    return;
  }

  const ok = await bcrypt.compare(pin, pinRow.pin_hash);
  if (!ok) {
    const attempts = (pinRow.failed_attempts || 0) + 1;
    const patch = { failed_attempts: attempts };
    if (attempts >= MAX_ATTEMPTS) {
      patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
      patch.failed_attempts = 0;
    }
    try { await sbUpdate('admin_user_pins', `email=eq.${encodeURIComponent(email)}`, patch); } catch (_) {}
    res.status(401).json({ error: 'Invalid credentials', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) });
    return;
  }

  // Success: reset counters, mark last_used_at
  try {
    await sbUpdate('admin_user_pins', `email=eq.${encodeURIComponent(email)}`, {
      failed_attempts: 0,
      locked_until: null,
      last_used_at: new Date().toISOString(),
    });
  } catch (_) {}

  const { token, expiresAt } = signToken(email, ADMIN_TOKEN_SECRET);
  res.status(200).json({
    token,
    expiresAt,
    email,
    role: user.role,
    displayName: user.display_name,
  });
};
