// POST /api/upload-report?folder=monthly|committee|annual&filename=foo.pdf
// Body: raw PDF bytes
// Header: x-admin-token: <token>
// Returns: { ok: true, url } or { error }

const { verifyAdminToken } = require('./_admin-auth');

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

  const token = req.headers['x-admin-token'];
  if (!verifyAdminToken(token, ADMIN_TOKEN_SECRET)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

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
  // Sanitize: only allow alnum, dash, underscore, dot
  filename = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!filename.toLowerCase().endsWith('.pdf')) {
    filename += '.pdf';
  }
  if (filename.length > 200) {
    res.status(400).json({ error: 'filename too long' });
    return;
  }

  // Read raw body — Vercel by default parses JSON; we need raw bytes
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    // Cap at 25 MB to match bucket limit
    if (Buffer.concat(chunks).length > 26214400) {
      res.status(413).json({ error: 'File too large (max 25 MB)' });
      return;
    }
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }
  // Quick PDF magic-number check
  if (body.slice(0, 4).toString() !== '%PDF') {
    res.status(400).json({ error: 'Not a PDF file' });
    return;
  }

  const objectPath = `${folder}/${filename}`;
  const url = `${SUPABASE_URL}/storage/v1/object/reports/${objectPath}`;

  try {
    // Use upsert to allow overwriting same filename
    const r = await fetch(url, {
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

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/reports/${objectPath}`;
    res.status(200).json({ ok: true, url: publicUrl, filename });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', detail: String(e).slice(0, 200) });
  }
};

// Tell Vercel not to parse the body — we need raw PDF bytes
module.exports.config = {
  api: { bodyParser: false },
};
