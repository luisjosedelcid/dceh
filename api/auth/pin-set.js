// POST /api/auth/pin-set
// Body: { pin }  (6-digit numeric string)
// Auth: x-admin-token
//
// Creates or replaces the user's PIN backup.

const bcrypt = require('bcryptjs');
const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  const token = req.headers['x-admin-token'];
  const verified = verifyAdminToken(token, ADMIN_TOKEN_SECRET);
  if (!verified) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const email = verified.email.toLowerCase();

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const pin = String(body.pin || '');
  if (!/^\d{6}$/.test(pin)) {
    res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    return;
  }

  const hash = await bcrypt.hash(pin, 10);
  const now = new Date().toISOString();

  const existing = await sbSelect(
    'admin_user_pins',
    `select=email&email=eq.${encodeURIComponent(email)}&limit=1`
  );

  if (existing.length) {
    await sbUpdate('admin_user_pins', `email=eq.${encodeURIComponent(email)}`, {
      pin_hash: hash,
      updated_at: now,
      failed_attempts: 0,
      locked_until: null,
    });
  } else {
    await sbInsert('admin_user_pins', {
      email,
      pin_hash: hash,
    });
  }

  res.status(200).json({ ok: true });
};
