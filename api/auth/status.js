// GET /api/auth/status?email=<email>
// No auth required.
// Returns: { exists, hasPasskey, hasPin }
// Used by the lock screen to decide which unlock methods to offer.

const { sbSelect } = require('../_supabase');

module.exports = async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  const [users, passkeys, pins] = await Promise.all([
    sbSelect('admin_users', `select=email&email=eq.${encodeURIComponent(email)}&is_active=eq.true&limit=1`),
    sbSelect('admin_webauthn_credentials', `select=id&email=eq.${encodeURIComponent(email)}&limit=1`),
    sbSelect('admin_user_pins', `select=email&email=eq.${encodeURIComponent(email)}&limit=1`),
  ]);
  res.status(200).json({
    exists: users.length > 0,
    hasPasskey: passkeys.length > 0,
    hasPin: pins.length > 0,
  });
};
