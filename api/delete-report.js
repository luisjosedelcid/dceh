// DELETE /api/delete-report?folder=monthly|committee|annual&filename=foo.pdf
// Header: x-admin-token: <token>

const { requireRole } = require('./_require-role');
const { sbInsert } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Role check: only admins can delete reports
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const actor = auth.user.email || 'unknown';

  const folder = (req.query.folder || '').toString();
  if (!['monthly', 'committee', 'annual'].includes(folder)) {
    res.status(400).json({ error: 'Invalid folder' });
    return;
  }

  const filename = (req.query.filename || '').toString().trim();
  if (!filename || filename.includes('/') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  const objectPath = `${folder}/${filename}`;
  const url = `${SUPABASE_URL}/storage/v1/object/reports/${objectPath}`;

  try {
    const r = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      res.status(502).json({ error: 'Delete failed', detail: txt.slice(0, 200) });
      return;
    }

    // Audit (best-effort, non-blocking)
    sbInsert('report_audit', {
      actor_email: actor,
      action: 'delete',
      folder,
      filename,
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', detail: String(e).slice(0, 200) });
  }
};
