// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Manual trigger for screener refresh
// POST /api/admin/screener-refresh-now
//
// Admin-only. Kicks off the same chunked refresh chain that the cron
// runs, starting at chunk 0. Returns the log_id so the UI can poll
// screener_refresh_log for progress.
// ═══════════════════════════════════════════════════════════════════

const { requireCapability } = require('../_require-capability.js');
const { runScreenerRefresh } = require('../cron/screener-refresh.js');

module.exports = async (req, res) => {
  const auth = await requireCapability(req, 'SC-02');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Kick off chunk 0. This will fire-and-forget the next chunks.
    const result = await runScreenerRefresh({ chunk: 0, triggeredBy: 'manual' });

    // Chain remaining chunks (mirror of cron/screener-refresh.js self-chain)
    if (!result.isLast && result.nextChunk != null) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const nextUrl = `${proto}://${host}/api/cron/screener-refresh?chunk=${result.nextChunk}&chunk_size=250&log_id=${result.logId}`;
      fetch(nextUrl, { headers: { 'x-cron-secret': process.env.CRON_SECRET || '' } }).catch(() => {});
    }

    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
