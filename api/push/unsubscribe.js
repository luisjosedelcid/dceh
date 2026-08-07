// POST /api/push/unsubscribe
// Body: { endpoint }
// Auth: x-admin-token (any authenticated active user)
// Deletes the subscription row for the given endpoint IF it belongs to the caller.

'use strict';

const { requireCapability } = require('../_require-capability');
const { sbDelete } = require('../_supabase');

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
    const auth = await requireCapability(req, 'AU-04');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = await readJson(req);
    const endpoint = body && body.endpoint;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }
    // Restrict delete to caller's own subscription for safety.
    const q = `endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${encodeURIComponent(auth.user.email)}`;
    await sbDelete('push_subscriptions', q);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 300) });
  }
};
