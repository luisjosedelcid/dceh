// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Data Room file tombstones (admin-only).
// ───────────────────────────────────────────────────────────────────
// Files in the Data Room come from /data/dataroom_index.json (a static file
// in the repo). To support "delete from the UI" without rewriting the JSON
// on every action, we store tombstones in dataroom_hidden_files and the
// front-end filters them out. Restoring a file = deleting its tombstone.
//
//   GET    /api/admin/dataroom-files
//          → { items: [{ url, filename, folder_slug, sub_slug, hidden_at, hidden_by }] }
//
//   POST   /api/admin/dataroom-files
//          body: { url, filename?, folder_slug?, sub_slug? }
//          → { item: {...} }
//
//   DELETE /api/admin/dataroom-files?id=<uuid>
//          (un-hide a single tombstone)
//          → { ok: true }
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbDelete } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'dataroom_hidden_files',
        'select=*&order=hidden_at.desc&limit=2000'
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const url = (body.url || '').toString().trim();
      const filename = body.filename ? String(body.filename).trim() : null;
      if (!url && !filename) {
        res.status(400).json({ error: 'url or filename is required' });
        return;
      }
      const row = {
        folder_slug: body.folder_slug ? String(body.folder_slug).slice(0, 80) : null,
        sub_slug: body.sub_slug ? String(body.sub_slug).slice(0, 80) : null,
        filename: filename ? filename.slice(0, 300) : null,
        url: url ? url.slice(0, 600) : null,
        hidden_by: actor,
      };
      const result = await sbInsert('dataroom_hidden_files', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      await sbDelete('dataroom_hidden_files', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
