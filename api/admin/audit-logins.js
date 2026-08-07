// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Login audit log (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET  /api/admin/audit-logins
//   Query params:
//     days     integer 1-90 (default 30) — rolling window
//     email    optional string — filter by exact email
//     success  optional 'true'|'false' — filter by outcome
//     method   optional 'password'|'pin'|'passkey' — filter by auth method
//     limit    integer 1-500 (default 100)
//   → { items: [{ id, email, ip, success, user_agent, auth_method,
//                failure_reason, attempted_at }],
//       stats: { total, success, failed, unique_emails, unique_ips,
//                by_reason: {...}, by_method: {...} } }
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const actor = requireAuth(req, res);
  if (!actor) return;

  const q = req.query || {};
  const days   = clampInt(q.days, 1, 90, 30);
  const limit  = clampInt(q.limit, 1, 500, 100);
  const emailF = (q.email || '').toString().trim().toLowerCase();
  const succF  = (q.success || '').toString().trim().toLowerCase();
  const methF  = (q.method  || '').toString().trim().toLowerCase();

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const parts = [
    'select=id,email,ip,success,user_agent,auth_method,failure_reason,attempted_at',
    `attempted_at=gte.${encodeURIComponent(sinceIso)}`,
    'order=attempted_at.desc',
    `limit=${limit}`,
  ];
  if (emailF) parts.push(`email=eq.${encodeURIComponent(emailF)}`);
  if (succF === 'true')  parts.push('success=eq.true');
  if (succF === 'false') parts.push('success=eq.false');
  if (['password','pin','passkey'].includes(methF)) parts.push(`auth_method=eq.${methF}`);

  let items = [];
  try {
    items = await sbSelect('login_attempts', parts.join('&'));
  } catch (e) {
    res.status(500).json({ error: 'Query failed', detail: String(e.message || e).slice(0, 300) });
    return;
  }

  // Aggregate stats from the returned slice (bounded by `limit`).
  const stats = {
    total: items.length,
    success: 0,
    failed: 0,
    unique_emails: 0,
    unique_ips: 0,
    by_reason: {},
    by_method: {},
    window_days: days,
    since: sinceIso,
  };
  const emails = new Set();
  const ips = new Set();
  for (const r of items) {
    if (r.success) stats.success++; else stats.failed++;
    if (r.email) emails.add(r.email);
    if (r.ip) ips.add(r.ip);
    if (!r.success && r.failure_reason) {
      stats.by_reason[r.failure_reason] = (stats.by_reason[r.failure_reason] || 0) + 1;
    }
    const m = r.auth_method || 'password';
    stats.by_method[m] = (stats.by_method[m] || 0) + 1;
  }
  stats.unique_emails = emails.size;
  stats.unique_ips = ips.size;

  res.status(200).json({ items, stats });
};
