// POST /api/auth/passkey-register-finish
// Body: { email, deviceName, response }  (response = the object returned by navigator.credentials.create)
// Auth: x-admin-token
//
// Verifies the registration response against the stored challenge, and
// persists the new credential to admin_webauthn_credentials.

const {
  verifyRegistrationResponse,
  getRpId,
  getExpectedOrigin,
  toB64Url,
} = require('../_webauthn');
const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbDelete } = require('../_supabase');

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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = String(body.email || verified.email).toLowerCase();
  if (email !== verified.email.toLowerCase()) {
    res.status(403).json({ error: 'Cannot register credentials for another user' });
    return;
  }
  const deviceName = String(body.deviceName || 'Unknown device').slice(0, 80);
  const response = body.response;
  if (!response) {
    res.status(400).json({ error: 'Missing response' });
    return;
  }

  // Look up the latest registration challenge for this user
  const challenges = await sbSelect(
    'admin_webauthn_challenges',
    `select=id,challenge,expires_at&email=eq.${encodeURIComponent(email)}&purpose=eq.registration&order=created_at.desc&limit=1`
  );
  if (!challenges.length) {
    res.status(400).json({ error: 'No pending registration challenge' });
    return;
  }
  const ch = challenges[0];
  if (new Date(ch.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Challenge expired' });
    return;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
      requireUserVerification: true,
    });
  } catch (e) {
    res.status(400).json({ error: 'Verification failed', detail: String(e.message || e).slice(0, 200) });
    return;
  }

  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: 'Registration not verified' });
    return;
  }

  const info = verification.registrationInfo;
  // simplewebauthn v13 nests fields under `credential`
  const cred = info.credential || info;
  const credentialId = typeof cred.id === 'string' ? cred.id : toB64Url(cred.id || cred.credentialID);
  const publicKey = typeof cred.publicKey === 'string' ? cred.publicKey : toB64Url(cred.publicKey || cred.credentialPublicKey);
  const counter = Number(cred.counter || info.counter || 0);
  const transports = Array.isArray(response.response?.transports) ? response.response.transports : null;
  const aaguid = info.aaguid || null;

  try {
    await sbInsert('admin_webauthn_credentials', {
      email,
      credential_id: credentialId,
      public_key: publicKey,
      counter,
      transports,
      device_name: deviceName,
      aaguid,
    });
  } catch (e) {
    res.status(500).json({ error: 'Persist failed', detail: String(e.message || e).slice(0, 200) });
    return;
  }

  // Consume challenge
  try { await sbDelete('admin_webauthn_challenges', `id=eq.${ch.id}`); } catch (_) {}

  res.status(200).json({ ok: true, credentialId });
};
