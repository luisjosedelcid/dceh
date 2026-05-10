// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Study uploaded files list / delete / rename (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET    /api/admin/study-files
//          → { items: [{ id, section, name, filename, url, size_bytes, mime_type,
//                        detail, uploaded_by, uploaded_at }] }
// DELETE /api/admin/study-files?id=<uuid>
//          → { ok: true }   Hard-deletes storage object + metadata row.
// PATCH  /api/admin/study-files?id=<uuid>
//          Body: { name?, detail? }   → { ok: true, item }
//          Renames the display name and/or updates detail.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbDelete, sbUpdate } = require('../_supabase');

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

async function deleteStorageObject(storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/study/${storagePath}`, {
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
        'study_files',
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
      const rows = await sbSelect('study_files', `select=id,storage_path&id=eq.${id}&limit=1`);
      if (rows.length === 0) { res.status(404).json({ error: 'not found' }); return; }
      const row = rows[0];
      try { await deleteStorageObject(row.storage_path); } catch {}
      await sbDelete('study_files', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.name === 'string') {
        const v = body.name.trim().slice(0, 200);
        if (!v) { res.status(400).json({ error: 'name cannot be empty' }); return; }
        patch.name = v;
      }
      if (typeof body.detail === 'string') {
        patch.detail = body.detail.trim().slice(0, 300) || null;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'nothing to update' });
        return;
      }
      const result = await sbUpdate('study_files', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ ok: true, item });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
};
