// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Purge old login_attempts rows.
// Runs daily; deletes rows older than 24h.
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbDelete } = require('../_supabase.js');

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    await sbDelete('login_attempts', `attempted_at=lt.${encodeURIComponent(cutoff)}`);
    res.status(200).json({ ok: true, cutoff });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
