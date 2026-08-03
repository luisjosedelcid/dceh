// DCE Holdings — Cockpit alert dismiss
// POST /api/cockpit/dismiss-alert  { source: 'watch'|'price', id: <number> }
//   Marks the alert as acknowledged so it disappears from the cockpit's
//   "Price & watch alerts" card. The underlying alert row is NOT deleted or
//   re-armed — this is a visual dismissal only. The alert can re-surface if
//   its triggered_at (price_alerts) advances past the ack timestamp, or if
//   its deadline_review (watchlist) crosses a new threshold after ack.
//
// Auth: x-admin-token header (same as admin routes).
// Cockpit alert `id` strings look like 'watch_42' or 'price_17' — the client
// splits and sends source + numeric id.

const { verifyAdminToken } = require('../_admin-auth');
const { sbUpdate } = require('../_supabase');

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

module.exports = async (req, res) => {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body;
  try { body = await readJson(req); } catch { body = {}; }

  const source = String(body.source || '').toLowerCase();
  const id = parseInt(body.id, 10);
  if (!['watch', 'price'].includes(source)) {
    res.status(400).json({ error: "source must be 'watch' or 'price'" });
    return;
  }
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id required (numeric)' });
    return;
  }

  const table = source === 'watch' ? 'watchlist' : 'price_alerts';
  const patch = {
    cockpit_ack_at: new Date().toISOString(),
    cockpit_ack_by: auth.email || null,
  };

  try {
    const updated = await sbUpdate(table, `id=eq.${id}`, patch);
    const row = Array.isArray(updated) ? updated[0] : updated;
    if (!row) {
      res.status(404).json({ error: `${source} alert ${id} not found` });
      return;
    }
    res.status(200).json({ ok: true, source, id, cockpit_ack_at: row.cockpit_ack_at });
  } catch (e) {
    console.error('dismiss-alert failed:', e.message);
    res.status(500).json({ error: 'update failed', detail: e.message });
  }
};
