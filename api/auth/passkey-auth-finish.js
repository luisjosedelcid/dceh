// POST /api/auth/passkey-auth-finish
// Body: { response }  (from navigator.credentials.get)
// Returns: { token, expiresAt, email, role, displayName }  — same shape as admin-login
//
// Verifies the assertion, bumps counter, and emits a signed admin token
// (the app's existing session mechanism).

const {
  verifyAuthenticationResponse,
  getRpId,
  getExpectedOrigin,
  fromB64Url,
} = require('../_webauthn');
const { signToken } = require('../_admin-auth');
const { sbSelect, sbUpdate, sbDelete } = require('../_supabase');

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
  const response = body.response;
  if (!response || !response.id) {
    res.status(400).json({ error: 'Missing response' });
    return;
  }

  // Look up credential by ID (id is base64url string from browser)
  const credentialId = String(response.id);
  const creds = await sbSelect(
    'admin_webauthn_credentials',
    `select=id,email,credential_id,public_key,counter,transports&credential_id=eq.${encodeURIComponent(credentialId)}&limit=1`
  );
  if (!creds.length) {
    res.status(404).json({ error: 'Unknown credential' });
    return;
  }
  const stored = creds[0];
  const email = stored.email;

  // Confirm user is still active
  const users = await sbSelect(
    'admin_users',
    `select=email,display_name,role&email=eq.${encodeURIComponent(email)}&is_active=eq.true&limit=1`
  );
  if (!users.length) {
    res.status(403).json({ error: 'User inactive' });
    return;
  }
  const user = users[0];

  // Retrieve the latest authentication challenge — match by email OR anon (usernameless)
  const challenges = await sbSelect(
    'admin_webauthn_challenges',
    `select=id,challenge,email,expires_at&purpose=eq.authentication&order=created_at.desc&limit=20`
  );
  // Pick the newest matching challenge (email match or anon)
  const ch = challenges.find(c => c.email === email || c.email === '__anon__');
  if (!ch) {
    res.status(400).json({ error: 'No pending authentication challenge' });
    return;
  }
  if (new Date(ch.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Challenge expired' });
    return;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
      credential: {
        id: stored.credential_id,
        // Library requires Uint8Array here, not a base64url string.
        publicKey: new Uint8Array(fromB64Url(stored.public_key)),
        counter: Number(stored.counter || 0),
        transports: stored.transports || undefined,
      },
      requireUserVerification: true,
    });
  } catch (e) {
    res.status(400).json({ error: 'Verification failed', detail: String(e.message || e).slice(0, 200) });
    return;
  }

  if (!verification.verified) {
    res.status(400).json({ error: 'Assertion not verified' });
    return;
  }

  // Bump counter, mark last_used_at
  try {
    const newCounter = verification.authenticationInfo?.newCounter;
    await sbUpdate(
      'admin_webauthn_credentials',
      `id=eq.${stored.id}`,
      {
        counter: Number(newCounter || stored.counter || 0),
        last_used_at: new Date().toISOString(),
      }
    );
  } catch (_) {}

  // Consume challenge
  try { await sbDelete('admin_webauthn_challenges', `id=eq.${ch.id}`); } catch (_) {}

  // Emit admin token (same mechanism as password login)
  const { token, expiresAt } = signToken(email, ADMIN_TOKEN_SECRET);
  res.status(200).json({
    token,
    expiresAt,
    email,
    role: user.role,
    displayName: user.display_name,
  });
};
