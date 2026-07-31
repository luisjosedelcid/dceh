// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Admin: trigger idea-feed refresh on demand
// POST /api/admin/refresh-feed-now
// Auth: x-admin-token header
//
// Wraps the cron handler at /api/cron/refresh-feed so admins can
// re-run it manually from Settings without exposing CRON_SECRET.
// ═══════════════════════════════════════════════════════════════════

const cronHandler = require('../cron/refresh-feed.js');
const { verifyAdminToken } = require('../_admin-auth.js');

function checkAuth(req) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) return null;
  return verifyAdminToken(tok, secret);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = checkAuth(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return; }

  // Inject the cron secret so the underlying handler passes its own auth check.
  const originalGet = req.headers['x-cron-secret'];
  req.headers['x-cron-secret'] = process.env.CRON_SECRET || '';
  try {
    await cronHandler(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  } finally {
    // Restore in case req is reused
    if (originalGet !== undefined) req.headers['x-cron-secret'] = originalGet;
    else delete req.headers['x-cron-secret'];
  }
};
