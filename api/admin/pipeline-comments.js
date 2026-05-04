// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Pipeline Card Comments CRUD (admin-only)
// ───────────────────────────────────────────────────────────────────
// All requests require x-admin-token. Bypasses RLS via service role.
//
//   GET    /api/admin/pipeline-comments
//          → { items: [...] }   (all comments — workflow loads them in bulk)
//   GET    /api/admin/pipeline-comments?card_id=<uuid>
//          → { items: [...] }   (filtered to a single card)
//   POST   /api/admin/pipeline-comments
//          body: { card_id, body }
//          → { item: {...} }    (author taken from auth token)
//   DELETE /api/admin/pipeline-comments?id=<uuid>
//          → { ok: true }       (only original author can delete — enforced)
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbDelete } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const v = verifyAdminToken(tok, secret);
  if (!v) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return v.email || 'admin';
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const cardId = (req.query.card_id || '').toString();
      let q = 'select=*&order=created_at.asc&limit=2000';
      if (cardId) {
        if (!/^[0-9a-f-]{36}$/i.test(cardId)) {
          res.status(400).json({ error: 'Invalid card_id' });
          return;
        }
        q += `&card_id=eq.${cardId}`;
      }
      const items = await sbSelect('comments', q);
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }

      const cardId = (body.card_id || '').toString();
      const text = (body.body || '').toString().trim();

      if (!/^[0-9a-f-]{36}$/i.test(cardId)) {
        res.status(400).json({ error: 'Invalid card_id' });
        return;
      }
      if (!text) {
        res.status(400).json({ error: 'Comment body required' });
        return;
      }
      if (text.length > 4000) {
        res.status(400).json({ error: 'Comment too long (max 4000)' });
        return;
      }

      // Resolve author display name from admin_users (best-effort)
      let displayName = actor;
      try {
        const users = await sbSelect(
          'admin_users',
          `select=display_name&email=eq.${encodeURIComponent(actor)}&limit=1`
        );
        if (users && users[0] && users[0].display_name) displayName = users[0].display_name;
      } catch {}

      const row = {
        card_id: cardId,
        author_username: actor,         // email (used as identity key)
        author_name: displayName,        // human-readable name
        author_avatar: null,
        body: text,
      };

      const result = await sbInsert('comments', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }

      // Only the original author can delete their own comment
      const existing = await sbSelect(
        'comments',
        `select=author_username&id=eq.${id}&limit=1`
      );
      if (!existing || existing.length === 0) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      if (existing[0].author_username !== actor) {
        res.status(403).json({ error: 'Forbidden — not the author' });
        return;
      }

      await sbDelete('comments', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
