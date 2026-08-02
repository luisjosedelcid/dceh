// GET /api/push/vapid-public-key
// Returns the VAPID public key so the browser can subscribe.
// Public endpoint (no auth) — the public key is safe to expose.

'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    res.status(500).json({ error: 'VAPID not configured' });
    return;
  }
  res.status(200).json({ publicKey: key });
};
