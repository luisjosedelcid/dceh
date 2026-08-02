// POST /api/auth/passkey-auth-begin
// Body: { email }  (optional — supports usernameless flow)
// No auth required (this is the login endpoint itself)
//
// Returns WebAuthn authentication options. Stores challenge for verify step.

const {
  generateAuthenticationOptions,
  getRpId,
} = require('../_webauthn');
const { sbSelect, sbInsert } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = body.email ? String(body.email).toLowerCase() : null;

  // If email is provided, restrict allowed credentials; otherwise usernameless (resident key)
  let allowCredentials;
  if (email) {
    const rows = await sbSelect(
      'admin_webauthn_credentials',
      `select=credential_id,transports&email=eq.${encodeURIComponent(email)}`
    );
    if (!rows.length) {
      res.status(404).json({ error: 'No passkeys registered for this user' });
      return;
    }
    allowCredentials = rows.map(r => ({
      id: r.credential_id,
      transports: r.transports || undefined,
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    userVerification: 'required',
    allowCredentials,
  });

  // Store challenge — keyed by email if we have it, else store with a wildcard
  // that the verify step can also match to the credential's actual owner.
  await sbInsert('admin_webauthn_challenges', {
    email: email || '__anon__',
    challenge: options.challenge,
    purpose: 'authentication',
  });

  res.status(200).json(options);
};
