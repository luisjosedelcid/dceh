// GET /api/list-audit?limit=100[&folder=monthly|committee|annual]
// Header: x-admin-token: <token>
// Returns: { entries: [{ id, ts, actor_email, action, folder, filename, size_bytes, detail }] }

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect } = require('./_supabase');

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

  const folder = (req.query.folder || '').toString();
  const folderFilter = ['monthly', 'committee', 'annual'].includes(folder)
    ? `&folder=eq.${folder}` : '';

  try {
    const rows = await sbSelect(
      'report_audit',
      `select=id,ts,actor_email,action,folder,filename,size_bytes,detail&order=ts.desc&limit=${limit}${folderFilter}`
    );
    res.status(200).json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', detail: String(e).slice(0, 200) });
  }
};
