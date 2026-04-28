// POST /api/admin-login
// Body: { password: string }
// Response: { token: string, expiresAt: number } or { error }
//
// Issues a short-lived HMAC token (8h) when the admin password matches.

const crypto = require('crypto');

const TOKEN_TTL_SEC = 8 * 60 * 60; // 8 hours

function sign(payload, secret) {
  const h = crypto.createHmac('sha256', secret);
  h.update(payload);
  return h.digest('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

  if (!ADMIN_PASSWORD || !ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { password } = body || {};

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password required' });
    return;
  }

  // Constant-time compare to avoid timing attacks
  const pwBuf = Buffer.from(password.padEnd(64, '\0').slice(0, 64));
  const okBuf = Buffer.from(ADMIN_PASSWORD.padEnd(64, '\0').slice(0, 64));
  const match = crypto.timingSafeEqual(pwBuf, okBuf) && password.length === ADMIN_PASSWORD.length;

  if (!match) {
    // small constant delay to slow down brute force
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `admin.${expiresAt}`;
  const sig = sign(payload, ADMIN_TOKEN_SECRET);
  const token = `${payload}.${sig}`;

  res.status(200).json({ token, expiresAt });
};
