// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Data Room file upload (admin-only)
// ───────────────────────────────────────────────────────────────────
// POST /api/admin/dataroom-upload?folder_id=<uuid>&filename=<name>&detail=<text>
// Body: raw file bytes (any type)
// Header: x-admin-token: <token>
//
// Behavior:
//   1. Authenticates admin via x-admin-token.
//   2. Validates target folder exists in dataroom_folders.
//   3. Sanitizes filename, prefixes with timestamp to avoid collisions,
//      uploads to Supabase Storage bucket 'dataroom' under {folder_id}/{ts}__{filename}.
//   4. Inserts a row in public.dataroom_files with the resulting public URL.
//   5. Returns { ok, item }.
//
// Notes:
//   - Bucket 'dataroom' is public (read-only); writes require service-role key.
//   - Max body size: 25 MB (Vercel hard limit on serverless functions).
//   - Filename is preserved as the displayed name; storage_path adds timestamp.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert } = require('../_supabase');
const { mirrorDataroomToStudy } = require('../_sector_mirror');

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|json|md|txt|png|jpe?g|zip)$/i;

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

function nowUnix() { return Math.floor(Date.now() / 1000); }

function sanitizeFilename(name) {
  // Keep extension; replace anything else weird with underscore
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 200);
}

function detectMime(filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt:  'application/vnd.ms-powerpoint',
    csv:  'text/csv',
    json: 'application/json',
    md:   'text/markdown',
    txt:  'text/plain',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    zip:  'application/zip',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const actor = requireAuth(req, res);
  if (!actor) return;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // ── Validate query params ─────────────────────────────────────
  const folderId = (req.query.folder_id || '').toString();
  if (!/^[0-9a-f-]{36}$/i.test(folderId)) {
    res.status(400).json({ error: 'folder_id (uuid) is required' });
    return;
  }

  let filename = sanitizeFilename(req.query.filename || '');
  if (!filename) {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  if (!ALLOWED_EXT.test(filename)) {
    res.status(400).json({ error: 'unsupported file type' });
    return;
  }

  const displayName = (req.query.name || filename).toString().slice(0, 200);
  const detail = (req.query.detail || '').toString().slice(0, 300);

  // ── Validate folder exists ─────────────────────────────────────
  const folders = await sbSelect('dataroom_folders', `select=id,name&id=eq.${folderId}&limit=1`);
  if (!folders.length) {
    res.status(404).json({ error: 'folder not found' });
    return;
  }

  // ── Read body ─────────────────────────────────────────────────
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES) {
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

  // ── Upload to Supabase Storage bucket 'dataroom' ───────────────
  const ts = nowUnix();
  const storagePath = `${folderId}/${ts}__${filename}`;
  const uploadUrl   = `${SUPABASE_URL}/storage/v1/object/dataroom/${storagePath}`;
  const mime        = detectMime(filename);

  try {
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body,
    });
    if (!r.ok) {
      const txt = await r.text();
      res.status(502).json({ error: 'Upload failed', detail: txt.slice(0, 200) });
      return;
    }
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', detail: String(e).slice(0, 200) });
    return;
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/dataroom/${storagePath}`;

  // ── Insert metadata row ────────────────────────────────────────
  let item;
  try {
    const result = await sbInsert('dataroom_files', {
      folder_id: folderId,
      name: displayName,
      filename,
      storage_path: storagePath,
      url: publicUrl,
      size_bytes: body.length,
      mime_type: mime,
      detail: detail || null,
      uploaded_by: actor,
    });
    item = Array.isArray(result) ? result[0] : result;
  } catch (e) {
    // File is uploaded but row failed — surface error so client can retry
    res.status(500).json({ error: 'Metadata insert failed', detail: String(e).slice(0, 200), url: publicUrl });
    return;
  }

  // Mirror to Study / Sector section if this upload landed in Sector Briefs folder
  try {
    if (item) {
      await mirrorDataroomToStudy(item);
    }
  } catch (e) {
    console.error('mirrorDataroomToStudy failed:', e.message);
  }

  res.status(200).json({ ok: true, item });
};

module.exports.config = {
  api: { bodyParser: false },
};
