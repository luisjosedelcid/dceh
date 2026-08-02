// POST /api/push/subscribe
// Body: { endpoint, keys: { p256dh, auth }, user_agent?, device_hint? }
// Auth: x-admin-token (any authenticated active user)
// Idempotent: on conflict of endpoint we update keys and reset failures.

'use strict';

const { requireRole } = require('../_require-role');
const { sbUpsert } = require('../_supabase');

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = await readJson(req);
    const endpoint = body && body.endpoint;
    const p256dh = body && body.keys && body.keys.p256dh;
    const authKey = body && body.keys && body.keys.auth;
    if (!endpoint || !p256dh || !authKey) {
      res.status(400).json({ error: 'endpoint, keys.p256dh, keys.auth required' });
      return;
    }
    const row = {
      user_id: auth.user.email,
      endpoint,
      p256dh,
      auth: authKey,
      user_agent: (body.user_agent || req.headers['user-agent'] || '').slice(0, 500),
      device_hint: (body.device_hint || '').slice(0, 100),
      last_success_at: null,
      last_error_at: null,
      last_error: null,
      consecutive_failures: 0,
      updated_at: new Date().toISOString(),
    };
    const inserted = await sbUpsert('push_subscriptions', [row], 'endpoint');
    res.status(200).json({ ok: true, id: Array.isArray(inserted) ? inserted[0]?.id : null });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 300) });
  }
};
