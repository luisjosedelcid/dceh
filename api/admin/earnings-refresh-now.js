// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar manual refresh (admin-only)
// ───────────────────────────────────────────────────────────────────
// POST /api/admin/earnings-refresh-now
//      Body (optional): { tickers: ["LULU","ORLY", ...] }
//      → { ok, fetched, upserted, errors, tickers }
//
// Re-uses the exact logic from /api/cron/earnings-refresh so the manual
// trigger and the daily cron stay in sync.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { runEarningsRefresh } = require('../cron/earnings-refresh');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const actor = requireAuth(req, res);
  if (!actor) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const onlyTickers = Array.isArray(body && body.tickers) ? body.tickers : null;
    const summary = await runEarningsRefresh({ onlyTickers });
    res.status(200).json({ ...summary, actor });
  } catch (e) {
    res.status(500).json({ error: 'Refresh failed', detail: String(e).slice(0, 300) });
  }
};
