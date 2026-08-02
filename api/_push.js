// Shared Web Push helper.
// Uses `web-push` npm package. Requires env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
//
// Exports:
//   sendPushToUser(userEmail, payload)  -> { sent, failed, cleaned }
//   sendPushBroadcast(payload)          -> { sent, failed, cleaned }
//
// Payload shape:
//   { title, body, url?, tag?, icon?, badge?, data? }
//
// On 404/410 responses from push provider we increment consecutive_failures.
// After 3 consecutive failures we hard-delete the subscription.

'use strict';

const webpush = require('web-push');
const { sbSelect, sbUpdate, sbDelete } = require('./_supabase');

let _configured = false;
function ensureConfigured() {
  if (_configured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:luis@dceholdings.com';
  if (!pub || !priv) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(subj, pub, priv);
  _configured = true;
}

const DEFAULTS = {
  icon: '/icons/icon-192.png',
  badge: '/icons/icon-96.png',
  tag: 'dce-notification',
};

async function sendOne(sub, payload) {
  const pushSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const body = JSON.stringify({
    title: payload.title || 'DCE Holdings',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || DEFAULTS.tag,
    icon: payload.icon || DEFAULTS.icon,
    badge: payload.badge || DEFAULTS.badge,
    data: payload.data || {},
  });
  try {
    await webpush.sendNotification(pushSub, body, { TTL: 60 * 60 * 24 });
    // Success — reset failures
    await sbUpdate(
      'push_subscriptions',
      `id=eq.${sub.id}`,
      { last_success_at: new Date().toISOString(), consecutive_failures: 0, last_error: null }
    ).catch(() => {});
    return { status: 'sent' };
  } catch (err) {
    const code = err && (err.statusCode || err.status);
    const fatal = code === 404 || code === 410;
    const nextCount = (sub.consecutive_failures || 0) + 1;
    if (fatal || nextCount >= 3) {
      // Endpoint invalid — delete
      await sbDelete('push_subscriptions', `id=eq.${sub.id}`).catch(() => {});
      return { status: 'cleaned', code, err: String(err && err.body || err.message || err).slice(0, 200) };
    }
    await sbUpdate(
      'push_subscriptions',
      `id=eq.${sub.id}`,
      {
        last_error_at: new Date().toISOString(),
        last_error: String(err && err.body || err.message || err).slice(0, 300),
        consecutive_failures: nextCount,
      }
    ).catch(() => {});
    return { status: 'failed', code, err: String(err && err.body || err.message || err).slice(0, 200) };
  }
}

async function _fanout(subs, payload) {
  const results = { sent: 0, failed: 0, cleaned: 0, errors: [] };
  await Promise.all(subs.map(async (s) => {
    const r = await sendOne(s, payload);
    if (r.status === 'sent') results.sent++;
    else if (r.status === 'cleaned') results.cleaned++;
    else results.failed++;
    if (r.err) results.errors.push({ id: s.id, code: r.code, err: r.err });
  }));
  return results;
}

async function sendPushToUser(userEmail, payload) {
  ensureConfigured();
  const subs = await sbSelect(
    'push_subscriptions',
    `select=id,endpoint,p256dh,auth,consecutive_failures&user_id=eq.${encodeURIComponent(userEmail)}`
  );
  if (!subs.length) return { sent: 0, failed: 0, cleaned: 0, errors: [], no_subscriptions: true };
  return _fanout(subs, payload);
}

async function sendPushBroadcast(payload) {
  ensureConfigured();
  const subs = await sbSelect(
    'push_subscriptions',
    `select=id,endpoint,p256dh,auth,consecutive_failures,user_id`
  );
  if (!subs.length) return { sent: 0, failed: 0, cleaned: 0, errors: [], no_subscriptions: true };
  return _fanout(subs, payload);
}

module.exports = { sendPushToUser, sendPushBroadcast };
