// GET /api/list-audit?limit=100&offset=0[&folder=monthly|committee|annual][&actor=foo@bar.com][&action=upload]
// Header: x-admin-token: <token>
// Returns: { entries: [...], total: <number>, limit, offset }
//
// Filters:
//   folder  — eq filter on folder column (monthly|committee|annual)
//   actor   — eq filter on actor_email (exact match — UI may pass a dropdown value)
//   action  — eq filter on action column (login|upload|archive|delete|purge)
//
// Pagination: classic limit/offset; total comes from PostgREST count=exact header.

const { verifyAdminToken } = require('./_admin-auth');

const ALLOWED_ACTIONS = ['login', 'upload', 'archive', 'delete', 'purge'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

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

  let limit = parseInt(req.query.limit || '100', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  let offset = parseInt(req.query.offset || '0', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const folder = (req.query.folder || '').toString();
  const folderFilter = ['monthly', 'committee', 'annual'].includes(folder)
    ? `&folder=eq.${folder}` : '';

  const actor = (req.query.actor || '').toString().trim();
  const actorFilter = actor ? `&actor_email=eq.${encodeURIComponent(actor)}` : '';

  const action = (req.query.action || '').toString().trim();
  const actionFilter = ALLOWED_ACTIONS.includes(action) ? `&action=eq.${action}` : '';

  const query =
    `select=id,ts,actor_email,action,folder,filename,size_bytes,detail` +
    `&order=ts.desc&limit=${limit}&offset=${offset}` +
    folderFilter + actorFilter + actionFilter;

  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/report_audit?${query}`;
    const r = await fetch(url, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact',
      },
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(500).json({ error: 'Fetch failed', detail: t.slice(0, 200) });
      return;
    }
    const rows = await r.json();

    // PostgREST returns total in Content-Range: "0-99/1234"
    let total = null;
    const cr = r.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+|\*)$/);
      if (m && m[1] !== '*') total = parseInt(m[1], 10);
    }

    res.status(200).json({
      entries: rows,
      total: total != null ? total : rows.length,
      limit,
      offset,
      filters: { folder: folder || null, actor: actor || null, action: action || null },
    });
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', detail: String(e).slice(0, 200) });
  }
};
