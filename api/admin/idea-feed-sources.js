// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Admin CRUD for idea_feed_sources
// Auth: x-admin-token header
//
// GET    /api/admin/idea-feed-sources           → list all
// POST   /api/admin/idea-feed-sources           → create  (name, url, rss_url, kind, is_paid, notes)
// PATCH  /api/admin/idea-feed-sources?id=N      → update  (active, name, url, rss_url, kind, is_paid, notes)
// DELETE /api/admin/idea-feed-sources?id=N      → delete
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbInsert, sbUpdate, sbHeaders, sbBaseUrl } = require('../_supabase.js');
const { verifyAdminToken } = require('../_admin-auth.js');

function checkAuth(req) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) return null;
  return verifyAdminToken(tok, secret);
}

const ALLOWED_KINDS = new Set(['blog', 'substack', 'podcast', 'twitter', 'other']);

function sanitize(body) {
  const out = {};
  if (typeof body.name === 'string')   out.name = body.name.trim().slice(0, 200);
  if (typeof body.url === 'string')    out.url = body.url.trim().slice(0, 500);
  if (typeof body.rss_url === 'string') out.rss_url = body.rss_url.trim().slice(0, 500);
  if (typeof body.kind === 'string' && ALLOWED_KINDS.has(body.kind)) out.kind = body.kind;
  if (typeof body.is_paid === 'boolean') out.is_paid = body.is_paid;
  if (typeof body.active === 'boolean')  out.active = body.active;
  if (typeof body.notes === 'string')    out.notes = body.notes.trim().slice(0, 1000);
  return out;
}

module.exports = async (req, res) => {
  const auth = checkAuth(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    if (req.method === 'GET') {
      const rows = await sbSelect('idea_feed_sources', 'select=*&order=name.asc');
      res.status(200).json({ sources: rows });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const row = sanitize(body);
      if (!row.name || !row.url || !row.rss_url) {
        res.status(400).json({ error: 'name, url, rss_url required' });
        return;
      }
      if (!row.kind) row.kind = 'blog';
      const created = await sbInsert('idea_feed_sources', row);
      res.status(201).json({ source: Array.isArray(created) ? created[0] : created });
      return;
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: 'id required' }); return; }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const patch = sanitize(body);
      patch.updated_at = new Date().toISOString();
      const updated = await sbUpdate('idea_feed_sources', `id=eq.${id}`, patch);
      res.status(200).json({ source: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: 'id required' }); return; }
      const r = await fetch(`${sbBaseUrl()}/idea_feed_sources?id=eq.${id}`, {
        method: 'DELETE',
        headers: sbHeaders(),
      });
      if (!r.ok) { res.status(500).json({ error: 'delete failed' }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
