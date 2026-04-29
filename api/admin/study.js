// DCE Holdings — Study admin API
// GET    /api/admin/study                          → list all (active + inactive)
// POST   /api/admin/study                          → create (JSON body)
// PATCH  /api/admin/study?id=N                     → update (JSON body)
// DELETE /api/admin/study?id=N                     → soft-delete (set active=false)
// POST   /api/admin/study?upload=1&id=N&filename=…  → upload PDF (raw body)
//
// Auth: x-admin-token header (verified via _admin-auth.verifyAdminToken)

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

function slugify(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function uploadPdfBody(req, res, auth) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const id = parseInt(req.query.id || '', 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  let filename = (req.query.filename || '').toString().trim().replace(/[^A-Za-z0-9._-]/g, '_');
  if (!filename) filename = `article-${id}.pdf`;
  if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
  if (filename.length > 200) {
    res.status(400).json({ error: 'filename too long' });
    return;
  }

  // Read raw body (max 25 MB)
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 26214400) {
      res.status(413).json({ error: 'File too large (max 25 MB)' });
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }
  if (body.slice(0, 4).toString() !== '%PDF') {
    res.status(400).json({ error: 'Not a PDF file' });
    return;
  }

  // Look up the article to know its section
  const rows = await sbSelect('study_articles', `select=id,section&id=eq.${id}&limit=1`);
  if (!rows || rows.length === 0) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }
  const section = rows[0].section;
  const objectPath = `${section}/${id}/${filename}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/study/${objectPath}`;

  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'apikey': KEY,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    res.status(502).json({ error: 'Storage upload failed', detail: t.slice(0, 200) });
    return;
  }

  await sbUpdate('study_articles', `id=eq.${id}`, { storage_path: objectPath, updated_at: new Date().toISOString() });

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/study/${objectPath}`;
  res.status(200).json({ ok: true, pdf_url: publicUrl, storage_path: objectPath });
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

  // ── PDF upload branch ─────────────────────────
  if (req.method === 'POST' && req.query.upload === '1') {
    try {
      await uploadPdfBody(req, res, auth);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── JSON CRUD branches ────────────────────────
  try {
    if (req.method === 'GET') {
      const rows = await sbSelect('study_articles', 'select=*&order=section.asc,published_at.desc.nullslast,id.desc');
      res.status(200).json({ items: rows });
      return;
    }

    if (req.method === 'POST') {
      // Read JSON body
      let body = '';
      for await (const c of req) body += c;
      const data = JSON.parse(body || '{}');
      const section = (data.section || '').toString();
      if (!['sector', 'megatrends'].includes(section)) {
        res.status(400).json({ error: 'section must be sector or megatrends' });
        return;
      }
      const title = (data.title || '').toString().trim();
      if (!title) {
        res.status(400).json({ error: 'title required' });
        return;
      }
      const slug = slugify(data.slug || title) || ('article-' + Date.now());
      const rec = {
        section,
        title,
        slug,
        description: (data.description || '').toString().slice(0, 2000) || null,
        author: (data.author || '').toString().slice(0, 200) || null,
        tags: Array.isArray(data.tags) ? data.tags.slice(0, 12).map(String) : [],
        external_url: (data.external_url || '').toString().slice(0, 500) || null,
        cover_emoji: (data.cover_emoji || '').toString().slice(0, 8) || null,
        published_at: data.published_at || new Date().toISOString(),
        created_by: auth.email || null,
        active: true,
      };
      const created = await sbInsert('study_articles', rec);
      res.status(200).json({ ok: true, item: Array.isArray(created) ? created[0] : created });
      return;
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      let body = '';
      for await (const c of req) body += c;
      const data = JSON.parse(body || '{}');
      const patch = { updated_at: new Date().toISOString() };
      const allowed = ['section', 'title', 'slug', 'description', 'author', 'tags', 'external_url', 'cover_emoji', 'published_at', 'active'];
      for (const k of allowed) if (k in data) patch[k] = data[k];
      if (patch.section && !['sector', 'megatrends'].includes(patch.section)) {
        res.status(400).json({ error: 'invalid section' });
        return;
      }
      if (patch.slug) patch.slug = slugify(patch.slug);
      const updated = await sbUpdate('study_articles', `id=eq.${id}`, patch);
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      // Soft delete to preserve audit trail
      await sbUpdate('study_articles', `id=eq.${id}`, { active: false, updated_at: new Date().toISOString() });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
