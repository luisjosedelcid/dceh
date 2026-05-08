// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Data Room uploaded files list (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET    /api/admin/dataroom-uploaded-files
//   → { items: [{ id, folder_id, name, filename, url, size_bytes, mime_type,
//                 detail, uploaded_by, uploaded_at }] }
//
// DELETE /api/admin/dataroom-uploaded-files?id=<uuid>
//   → { ok: true }
//   Hard-deletes both the storage object and the metadata row.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbDelete } = require('../_supabase');

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
        'select=*&order=uploaded_at.desc&limit=2000'
      );
      res.status(200).json({ items });
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
