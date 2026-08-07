// GET  /api/admin-discipline-eval
//   Returns { evaluated_at, summary, violations }.
//   Read-only diagnostic — no push sent.
//
// POST /api/admin-discipline-eval  (body: { send: true })
//   Same, but ALSO pushes the alert to admin(s) — for testing the pipeline.
//
// Auth: admin only.

'use strict';

const { requireCapability } = require('./_require-capability');
const { evaluateDiscipline } = require('./_discipline-eval');
const { sendPushToUser } = require('./_push');
const { sbSelect } = require('./_supabase');

async function getAdminEmails() {
  try {
    const rows = await sbSelect(
      'admin_users',
      'select=email&role=eq.admin&status=eq.active'
    );
    const emails = (rows || []).map(r => (r.email || '').toLowerCase()).filter(Boolean);
    if (emails.length) return emails;
  } catch (_) { /* fallthrough */ }
  const fallback = (process.env.VAPID_SUBJECT || 'mailto:luis@dceholdings.com')
    .replace(/^mailto:/i, '').trim().toLowerCase();
  return fallback ? [fallback] : [];
}

module.exports = async (req, res) => {
  try {
    const auth = await requireCapability(req, 'DR-03');
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const result = await evaluateDiscipline();

    let send = false;
    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        send = !!body.send;
      } catch (_) { /* ignore */ }
    }

    if (send && result.violations.length) {
      const fails = result.summary.fails;
      const warns = result.summary.warns;
      const titleParts = [];
      if (fails) titleParts.push(`${fails} FAIL`);
      if (warns) titleParts.push(`${warns} WARN`);
      const title = `Discipline · ${titleParts.join(' · ')} (test)`;
      const lines = [];
      const ordered = [...result.violations.filter(v => v.level === 'FAIL'),
                       ...result.violations.filter(v => v.level === 'WARN')].slice(0, 4);
      for (const v of ordered) lines.push((v.level === 'FAIL' ? '⛔ ' : '⚠ ') + v.message);
      const extra = result.violations.length - ordered.length;
      if (extra > 0) lines.push(`+ ${extra} más…`);

      const admins = await getAdminEmails();
      const results = [];
      for (const email of admins) {
        try {
          const r = await sendPushToUser(email, {
            title,
            body: lines.join('\n'),
            url: '/settings.html#discipline',
            tag: 'discipline-test-' + Date.now(),
            data: { kind: 'discipline_alert_test', evaluated_at: result.evaluated_at },
          });
          results.push({ email, ...r });
        } catch (e) {
          results.push({ email, error: String(e && e.message || e) });
        }
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.status(200).end(JSON.stringify({ ok: true, ...result, sent: true, admins: admins.length, results }));
      return;
    }

    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.status(200).end(JSON.stringify({ ok: true, ...result, sent: false }));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
