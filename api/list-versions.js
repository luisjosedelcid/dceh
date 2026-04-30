// GET /api/list-versions?folder=monthly&filename=foo.pdf
// Header: x-admin-token: <token>
// Returns: { versions: [{ ts, archivePath, url, sizeBytes, actor }] }
// Lists archived versions of a given filename plus the current live one.

const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Role check: only admins can view archived report versions
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const folder = (req.query.folder || '').toString();
  const filename = (req.query.filename || '').toString();
  if (!['monthly', 'committee', 'annual'].includes(folder)) {
    res.status(400).json({ error: 'Invalid folder' }); return;
  }
  if (!filename || filename.includes('/') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid filename' }); return;
  }

  try {
    // List archive/<folder>/ — Supabase Storage list endpoint
    const listUrl = `${SUPABASE_URL}/storage/v1/object/list/reports`;
    const r = await fetch(listUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: `archive/${folder}/`,
        limit: 1000,
        sortBy: { column: 'name', order: 'desc' },
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      res.status(502).json({ error: 'List failed', detail: txt.slice(0, 200) });
      return;
    }
    const items = await r.json();

    // Filter to those matching our filename: "<unix_ts>__<filename>"
    const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
    const matches = items
      .filter(it => it.name && it.name.endsWith(`__${safe}`))
      .map(it => {
        const m = it.name.match(/^(\d+)__/);
        const ts = m ? parseInt(m[1], 10) * 1000 : null;
        const path = `archive/${folder}/${it.name}`;
        return {
          ts,
          archivePath: path,
          url: `${SUPABASE_URL}/storage/v1/object/public/reports/${path}`,
          sizeBytes: it.metadata && it.metadata.size,
        };
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    res.status(200).json({
      filename,
      folder,
      currentUrl: `${SUPABASE_URL}/storage/v1/object/public/reports/${folder}/${filename}`,
      versions: matches,
    });
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', detail: String(e).slice(0, 200) });
  }
};
