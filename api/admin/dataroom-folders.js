// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Data Room folders CRUD (admin-only)
// ───────────────────────────────────────────────────────────────────
//   GET    /api/admin/dataroom-folders
//          → { items: [...] }  (full tree, flat array; build hierarchy client-side)
//
//   POST   /api/admin/dataroom-folders
//          body: { name, parent_id?, description?, access_note?, slug?, order_index?, metadata? }
//          → { item: {...} }
//
//   PATCH  /api/admin/dataroom-folders?id=<uuid>
//          body: any subset of { name, description, access_note, parent_id, order_index, slug, metadata }
//          → { item: {...} }
//
//   DELETE /api/admin/dataroom-folders?id=<uuid>&force=1
//          force=1 required if folder has children (cascade deletes descendants)
//          system folders (is_system=true) cannot be deleted at all
//          → { ok: true }
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

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

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

function isUuid(s) { return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s); }

function slugify(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'folder';
}

async function ensureUniqueSlug(parentId, baseSlug) {
  // Find sibling slugs to avoid collision (case-insensitive on lower)
  const filter = parentId
    ? `parent_id=eq.${parentId}`
    : `parent_id=is.null`;
  const siblings = await sbSelect('dataroom_folders', `select=slug&${filter}&limit=500`);
  const taken = new Set((siblings || []).map(r => (r.slug || '').toLowerCase()));
  if (!taken.has(baseSlug.toLowerCase())) return baseSlug;
  let i = 2;
  while (taken.has(`${baseSlug}_${i}`.toLowerCase())) i++;
  return `${baseSlug}_${i}`;
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'dataroom_folders',
        'select=id,parent_id,slug,name,description,access_note,order_index,is_system,metadata,created_at,updated_at,created_by,updated_by&order=order_index.asc,name.asc&limit=2000'
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const name = String(body.name || '').trim();
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      if (name.length > 120) { res.status(400).json({ error: 'name too long (max 120)' }); return; }

      const parent_id = body.parent_id ? String(body.parent_id) : null;
      if (parent_id && !isUuid(parent_id)) {
        res.status(400).json({ error: 'invalid parent_id' });
        return;
      }
      // Verify parent exists
      if (parent_id) {
        const parent = await sbSelect('dataroom_folders', `select=id&id=eq.${parent_id}&limit=1`);
        if (!parent || parent.length === 0) {
          res.status(404).json({ error: 'parent folder not found' });
          return;
        }
      }

      const baseSlug = body.slug ? slugify(body.slug) : slugify(name);
      const slug = await ensureUniqueSlug(parent_id, baseSlug);

      // Compute order_index if not provided: max(siblings)+1
      let order_index = Number.isFinite(body.order_index) ? Math.floor(body.order_index) : null;
      if (order_index === null) {
        const filter = parent_id ? `parent_id=eq.${parent_id}` : `parent_id=is.null`;
        const sibs = await sbSelect('dataroom_folders', `select=order_index&${filter}&order=order_index.desc&limit=1`);
        const maxIdx = (sibs && sibs[0] && Number.isFinite(sibs[0].order_index)) ? sibs[0].order_index : 0;
        order_index = maxIdx + 1;
      }

      const row = {
        parent_id,
        slug,
        name,
        description: body.description ? String(body.description).slice(0, 500) : null,
        access_note: body.access_note ? String(body.access_note).slice(0, 200) : null,
        order_index,
        is_system: false,
        metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata : {},
        created_by: actor,
        updated_by: actor,
      };

      const result = await sbInsert('dataroom_folders', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!isUuid(id)) { res.status(400).json({ error: 'invalid id' }); return; }

      // Load current row to check is_system + parent
      const cur = await sbSelect('dataroom_folders', `select=id,parent_id,slug,is_system&id=eq.${id}&limit=1`);
      if (!cur || cur.length === 0) {
        res.status(404).json({ error: 'folder not found' });
        return;
      }
      const current = cur[0];
      const body = parseBody(req);
      const patch = { updated_by: actor };

      if (body.name !== undefined) {
        const n = String(body.name || '').trim();
        if (!n) { res.status(400).json({ error: 'name cannot be empty' }); return; }
        if (n.length > 120) { res.status(400).json({ error: 'name too long' }); return; }
        patch.name = n;
      }
      if (body.description !== undefined) {
        patch.description = body.description ? String(body.description).slice(0, 500) : null;
      }
      if (body.access_note !== undefined) {
        patch.access_note = body.access_note ? String(body.access_note).slice(0, 200) : null;
      }
      if (body.order_index !== undefined && Number.isFinite(body.order_index)) {
        patch.order_index = Math.floor(body.order_index);
      }
      if (body.metadata !== undefined && typeof body.metadata === 'object') {
        patch.metadata = body.metadata;
      }
      if (body.slug !== undefined) {
        if (current.is_system) {
          res.status(403).json({ error: 'cannot rename slug of a system folder' });
          return;
        }
        const newSlugBase = slugify(body.slug);
        const newSlug = await ensureUniqueSlug(
          body.parent_id !== undefined ? (body.parent_id || null) : current.parent_id,
          newSlugBase
        );
        patch.slug = newSlug;
      }
      if (body.parent_id !== undefined) {
        if (current.is_system) {
          res.status(403).json({ error: 'cannot move a system folder' });
          return;
        }
        const newParent = body.parent_id ? String(body.parent_id) : null;
        if (newParent && !isUuid(newParent)) {
          res.status(400).json({ error: 'invalid parent_id' });
          return;
        }
        if (newParent === id) {
          res.status(400).json({ error: 'folder cannot be its own parent' });
          return;
        }
        if (newParent) {
          const parent = await sbSelect('dataroom_folders', `select=id&id=eq.${newParent}&limit=1`);
          if (!parent || parent.length === 0) {
            res.status(404).json({ error: 'new parent not found' });
            return;
          }
        }
        patch.parent_id = newParent;
      }

      const result = await sbUpdate('dataroom_folders', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!isUuid(id)) { res.status(400).json({ error: 'invalid id' }); return; }
      const force = req.query.force === '1' || req.query.force === 'true';

      const cur = await sbSelect('dataroom_folders', `select=id,is_system,name&id=eq.${id}&limit=1`);
      if (!cur || cur.length === 0) {
        res.status(404).json({ error: 'folder not found' });
        return;
      }
      if (cur[0].is_system) {
        res.status(403).json({ error: 'cannot delete a system folder' });
        return;
      }

      // Check for children
      const children = await sbSelect(
        'dataroom_folders',
        `select=id&parent_id=eq.${id}&limit=1`
      );
      if (children && children.length > 0 && !force) {
        res.status(409).json({ error: 'folder has subfolders; pass force=1 to cascade delete' });
        return;
      }

      await sbDelete('dataroom_folders', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
