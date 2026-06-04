// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Data Room uploaded files list (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET    /api/admin/dataroom-uploaded-files
//   → { items: [{ id, folder_id, name, filename, url, size_bytes, mime_type,
//                 detail, uploaded_by, uploaded_at }] }
//
// PATCH  /api/admin/dataroom-uploaded-files?id=<uuid>
//   body: { folder_id?, name?, detail? }
//   → { item: {...} }
//
// DELETE /api/admin/dataroom-uploaded-files?id=<uuid>
//   → { ok: true }
//   Hard-deletes both the storage object and the metadata row.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbUpdate, sbDelete } = require('../_supabase');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

function isUuid(s) { return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s); }

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

async function deleteStorageObject(storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/dataroom/${storagePath}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${KEY}`, 'apikey': KEY },
  });
  return r.ok || r.status === 404;
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'dataroom_files',
        'select=*&order=order_index.asc,uploaded_at.asc&limit=2000'
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!isUuid(id)) { res.status(400).json({ error: 'invalid id' }); return; }
      const body = parseBody(req);
      const patch = {};
      if (body.folder_id !== undefined) {
        if (body.folder_id !== null && !isUuid(body.folder_id)) {
          res.status(400).json({ error: 'invalid folder_id' });
          return;
        }
        if (body.folder_id) {
          const parent = await sbSelect('dataroom_folders', `select=id&id=eq.${body.folder_id}&limit=1`);
          if (!parent || parent.length === 0) {
            res.status(404).json({ error: 'destination folder not found' });
            return;
          }
        }
        patch.folder_id = body.folder_id || null;
      }
      if (body.name !== undefined) patch.name = String(body.name || '').slice(0, 200) || null;
      if (body.detail !== undefined) patch.detail = String(body.detail || '').slice(0, 500) || null;
      if (body.order_index !== undefined) {
        const n = Number(body.order_index);
        if (!Number.isFinite(n) || n < 0 || n > 100000) {
          res.status(400).json({ error: 'invalid order_index' });
          return;
        }
        patch.order_index = Math.floor(n);
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no valid fields to update' });
        return;
      }
      const result = await sbUpdate('dataroom_files', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      if (!item) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      // Look up the row first to get storage_path
      const rows = await sbSelect('dataroom_files', `select=id,storage_path&id=eq.${id}&limit=1`);
      if (rows.length === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const row = rows[0];

      // Best-effort storage delete; row delete is the source of truth
      try { await deleteStorageObject(row.storage_path); } catch {}

      await sbDelete('dataroom_files', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
};
