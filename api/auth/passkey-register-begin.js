// POST /api/auth/passkey-register-begin
// Body: { email }
// Auth: x-admin-token (must be a valid current admin token for that email)
//
// Returns WebAuthn registration options that the browser passes to
// navigator.credentials.create(). Also stores the challenge so
// passkey-register-finish can verify it.

const {
  generateRegistrationOptions,
  getRpId,
  RP_NAME,
  fromB64Url,
} = require('../_webauthn');
const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert } = require('../_supabase');

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

  // Auth: must present a valid admin token (bootstrap uses the current login system)
  const token = req.headers['x-admin-token'];
  const verified = verifyAdminToken(token, ADMIN_TOKEN_SECRET);
  if (!verified) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = String(body.email || verified.email).toLowerCase();
  if (email !== verified.email.toLowerCase()) {
    res.status(403).json({ error: 'Cannot register credentials for another user' });
    return;
  }

  // Confirm the user exists and is active
  const users = await sbSelect(
    'admin_users',
    `select=email,display_name&email=eq.${encodeURIComponent(email)}&is_active=eq.true&limit=1`
  );
  if (!users.length) {
    res.status(404).json({ error: 'User not found or inactive' });
    return;
  }
  const user = users[0];

  // Existing credentials → exclude them from registration
  const existing = await sbSelect(
    'admin_webauthn_credentials',
    `select=credential_id,transports&email=eq.${encodeURIComponent(email)}`
  );
  const excludeCredentials = existing.map(c => ({
    id: c.credential_id,  // base64url string; simplewebauthn v13 accepts strings
    transports: c.transports || undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: getRpId(req),
    userName: email,
    userDisplayName: user.display_name || email,
    // Stable per-user handle so re-registrations link to the same user
    userID: Buffer.from(email, 'utf8'),
    attestationType: 'none',  // we don't need attestation for internal app
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',       // enables usernameless flows if possible
      userVerification: 'required',   // require Face ID / Touch ID / PIN
      authenticatorAttachment: 'platform',  // prefer built-in (Face ID/Touch ID)
    },
    supportedAlgorithmIDs: [-7, -257],  // ES256, RS256
  });

  // Store challenge for verify step
  await sbInsert('admin_webauthn_challenges', {
    email,
    challenge: options.challenge,
    purpose: 'registration',
  });

  res.status(200).json(options);
};
