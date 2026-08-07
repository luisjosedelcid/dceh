// POST /api/push/send
// Auth: admin-only (x-admin-token with admin role)
// Body:
//   { title, body, url?, tag?, icon?, badge?, data?,
//     to?: 'broadcast' | user_email | user_email[] }
//
// Default `to`: 'self' (the caller). Use 'broadcast' to hit all subs.
// Use array of emails for multi-user targeting.

'use strict';

const { requireCapability } = require('../_require-capability');
const { sendPushToUser, sendPushBroadcast } = require('../_push');

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
    const auth = await requireCapability(req, 'SL-02');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = await readJson(req);
    if (!body || !body.title) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    const payload = {
      title: String(body.title).slice(0, 120),
      body: body.body ? String(body.body).slice(0, 400) : '',
      url: body.url || '/',
      tag: body.tag,
      icon: body.icon,
      badge: body.badge,
      data: body.data || {},
    };
    let to = body.to;
    if (!to) to = 'self';
    if (to === 'self') to = auth.user.email;

    let result;
    if (to === 'broadcast') {
      result = await sendPushBroadcast(payload);
    } else if (Array.isArray(to)) {
      const all = { sent: 0, failed: 0, cleaned: 0, errors: [] };
      for (const email of to) {
        const r = await sendPushToUser(email, payload);
        all.sent += r.sent || 0;
        all.failed += r.failed || 0;
        all.cleaned += r.cleaned || 0;
        if (r.errors) all.errors.push(...r.errors);
      }
      result = all;
    } else {
      result = await sendPushToUser(String(to), payload);
    }
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 300) });
  }
};
