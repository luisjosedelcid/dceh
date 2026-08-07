// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Discipline Rules daily alerts cron
// GET /api/cron/discipline-alerts
//   - Evaluates the 6 discipline_rules against current portfolio state
//   - If ≥1 violation, sends a single push to admin(s) with a compact
//     summary. If everything is healthy, silent (no notification).
//
// Triggered by Vercel cron daily at 07:00 UTC = 09:00 CEST (summer) /
// 08:00 CET (winter). See vercel.json.
//
// Auth: `x-cron-secret` header matching CRON_SECRET, or Vercel-injected
//        `x-vercel-cron-schedule` header.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { evaluateDiscipline } = require('../_discipline-eval');
const { sendPushToUser } = require('../_push');
const { sbSelect } = require('../_supabase');

function levelIcon(level) {
  return level === 'FAIL' ? '⛔' : '⚠';
}

function buildPushBody(violations) {
  const fails = violations.filter(v => v.level === 'FAIL');
  const warns = violations.filter(v => v.level === 'WARN');
  const lines = [];
  // Show up to 4 lines total, FAILs first.
  const ordered = [...fails, ...warns].slice(0, 4);
  for (const v of ordered) {
    lines.push(`${levelIcon(v.level)} ${v.message}`);
  }
  const extra = violations.length - ordered.length;
  if (extra > 0) lines.push(`+ ${extra} más…`);
  return lines.join('\n');
}

async function getAdminEmails() {
  // All active admins receive the alert. Fallback to VAPID_SUBJECT owner if RLS/table missing.
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
    const expected = process.env.CRON_SECRET;
    const authHdr = req.headers.authorization || '';
    const bearerOk = !!expected && authHdr === `Bearer ${expected}`;
    const cronHdrOk = !!expected && req.headers['x-cron-secret'] === expected;
    const isVercelCron = 'x-vercel-cron-schedule' in req.headers || 'x-vercel-cron' in req.headers;
    if (!bearerOk && !cronHdrOk && !isVercelCron) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const dryRun = req.query && (req.query.dry === '1' || req.query.dry_run === '1');

    const result = await evaluateDiscipline();
    const { violations, summary } = result;

    // Silent if no violations
    if (!violations.length) {
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({
        ok: true, sent: false, reason: 'no_violations', summary, evaluated_at: result.evaluated_at,
      }));
      return;
    }

    if (dryRun) {
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({
        ok: true, dry_run: true, summary, violations,
      }));
      return;
    }

    const fails = summary.fails;
    const warns = summary.warns;
    const titleParts = [];
    if (fails) titleParts.push(`${fails} FAIL`);
    if (warns) titleParts.push(`${warns} WARN`);
    const title = `Discipline · ${titleParts.join(' · ')}`;
    const body = buildPushBody(violations);

    const admins = await getAdminEmails();
    const results = [];
    for (const email of admins) {
      try {
        const r = await sendPushToUser(email, {
          title,
          body,
          url: '/settings.html#discipline',
          tag: 'discipline-daily',
          data: { kind: 'discipline_alert', evaluated_at: result.evaluated_at, summary },
        });
        results.push({ email, ...r });
      } catch (e) {
        results.push({ email, error: String(e && e.message || e) });
      }
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true, sent: true, summary, admins: admins.length, results, evaluated_at: result.evaluated_at,
    }));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
