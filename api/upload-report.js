// POST /api/upload-report?folder=monthly|committee|annual&filename=foo.pdf
// Body: raw PDF bytes
// Header: x-admin-token: <token>
// Returns: { ok, url, filename, archived?: { from, to } }
//
// Behavior:
//   - If a file with the same name already exists in folder/, it is FIRST copied to
//     archive/<folder>/<unix_ts>__<filename> (keeps history) and then overwritten.
//   - Inserts a row in report_audit (action='upload'; if archived, also action='archive').
//   - Sends an email notification via Resend (best-effort).

const { verifyAdminToken } = require('./_admin-auth');
const { sbInsert } = require('./_supabase');
const { sendUploadEmail } = require('./_notify');

function nowUnix() { return Math.floor(Date.now() / 1000); }

async function objectExists(supabaseUrl, key, objectPath) {
  // HEAD on the public-object path returns 200 if the file exists.
  // Use the authenticated path so private-bucket safety still works.
  const r = await fetch(`${supabaseUrl}/storage/v1/object/info/reports/${objectPath}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${key}`, 'apikey': key },
  });
  return r.ok;
}

async function copyObject(supabaseUrl, key, fromPath, toPath) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: 'reports', sourceKey: fromPath, destinationKey: toPath }),
  });
  return r.ok;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const actor = auth.email || 'unknown';

  const folder = (req.query.folder || '').toString();
  if (!['monthly', 'committee', 'annual'].includes(folder)) {
    res.status(400).json({ error: 'Invalid folder' });
    return;
  }

  let filename = (req.query.filename || '').toString().trim();
  if (!filename) {
    res.status(400).json({ error: 'filename required' });
    return;
  }
  filename = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
  if (filename.length > 200) {
    res.status(400).json({ error: 'filename too long' });
    return;
  }

  // Read raw body
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

  const objectPath = `${folder}/${filename}`;
  const uploadUrl  = `${SUPABASE_URL}/storage/v1/object/reports/${objectPath}`;

  // ── Versioning: archive existing copy first ─────────────
  let archived = null;
  try {
    const exists = await objectExists(SUPABASE_URL, SUPABASE_SERVICE_KEY, objectPath);
    if (exists) {
      const archivePath = `archive/${folder}/${nowUnix()}__${filename}`;
      const ok = await copyObject(SUPABASE_URL, SUPABASE_SERVICE_KEY, objectPath, archivePath);
      if (ok) {
        archived = { from: objectPath, to: archivePath };
        sbInsert('report_audit', {
          actor_email: actor,
          action: 'archive',
          folder,
          filename,
          detail: archivePath,
        }).catch(() => {});
      }
    }
  } catch (e) {
    // If archive step fails, we still proceed to overwrite (best-effort versioning).
  }

  // ── Upload (upsert) ─────────────────────────────────────
  try {
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/pdf',
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

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/reports/${objectPath}`;

  // ── Audit + notify (best-effort, non-blocking) ──────────
  sbInsert('report_audit', {
    actor_email: actor,
    action: 'upload',
    folder,
    filename,
    size_bytes: body.length,
    detail: archived ? `replaced; previous archived to ${archived.to}` : 'new',
  }).catch(() => {});

  sendUploadEmail({
    folder,
    filename,
    actor,
    sizeBytes: body.length,
    publicUrl,
  }).catch(() => {});

  res.status(200).json({ ok: true, url: publicUrl, filename, archived });
};

module.exports.config = {
  api: { bodyParser: false },
};
