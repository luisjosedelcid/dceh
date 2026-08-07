// GET  /api/admin/backup-status  — list recent backup_log entries
// POST /api/admin/backup-status  — trigger a manual backup right now
//
// Auth: admin token via x-admin-token header (same as other admin endpoints).

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect } = require('../_supabase.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const decoded = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!decoded) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const rows = await sbSelect(
        'backup_log',
        'select=id,run_id,started_at,finished_at,status,kind,tables_dumped,rows_total,files_mirrored,bytes_total,storage_path,error&order=started_at.desc&limit=30'
      );
      res.status(200).json({ ok: true, entries: rows });
    } catch (e) {
      res.status(500).json({ error: 'Query failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  if (req.method === 'POST') {
    if (!CRON_SECRET) {
      res.status(500).json({ error: 'CRON_SECRET not set — cannot trigger manual backup' });
      return;
    }
    // Fire-and-await the nightly handler with kind=manual.
    // We call our own function inline instead of an HTTP roundtrip.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${host}/api/cron/backup-nightly?kind=manual`;
    try {
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
      });
      const j = await r.json().catch(() => ({}));
      res.status(r.ok ? 200 : 502).json({ ok: r.ok, result: j });
    } catch (e) {
      res.status(500).json({ error: 'Trigger failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
