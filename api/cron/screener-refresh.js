// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Screener snapshot refresh
// GET /api/cron/screener-refresh
//
// Runs the ROIC.ai batch pull for the full US listed universe and
// upserts one row per ticker into `screener_snapshot`.
//
// - Universe: NYSE + NASDAQ + AMEX, type=stock (~6,800 tickers)
// - Rate: 250 req/min effective (individual plan = 300 req/min)
// - Time: ~90 min per full snapshot (5 endpoints per ticker, parallelized
//   within each ticker but sequential across tickers to respect rate limit)
// - Idempotent: upserts by ticker PK, safe to re-run
//
// Auth: x-cron-secret header OR x-vercel-cron header (Vercel-triggered).
// Also invoked by /api/admin/screener-refresh-now.
//
// Vercel serverless timeout is 60s on Hobby, 300s Pro, 900s Enterprise.
// A full 90-min run WILL exceed even 900s. So this endpoint accepts:
//
//   ?chunk=0..N   — process only a slice of the universe
//   ?chunk_size=  — how many tickers per chunk (default 300)
//
// The cron schedule fires the driver `/api/cron/screener-refresh` which
// chains chunks by scheduling the next one via a queued invocation.
// For manual admin trigger, the UI polls progress.
// ═══════════════════════════════════════════════════════════════════

const { sbUpsert, sbInsert, sbUpdate, sbSelect } = require('../_supabase.js');
const { fetchTickerSnapshot, fetchUsTickers, roicRateLimiter } = require('../_roic.js');

const DEFAULT_CHUNK_SIZE = 250;   // 250 tickers × 5 calls = 1250 reqs, ~5 min at 250/min
const HARD_TIMEOUT_MS = 250_000;  // leave margin under Vercel's 300s Pro limit

async function runScreenerRefresh(opts = {}) {
  const {
    chunk = 0,
    chunkSize = DEFAULT_CHUNK_SIZE,
    triggeredBy = 'cron',
    logId = null,           // if provided, reuse this log row instead of creating a new one
  } = opts;

  const startedAt = Date.now();

  // 1) Fetch or reuse universe
  const universe = await fetchUsTickers();

  // 2) Slice for this chunk
  const start = chunk * chunkSize;
  const end = Math.min(start + chunkSize, universe.length);
  const slice = universe.slice(start, end);

  // 3) Log start (only on chunk 0)
  let currentLogId = logId;
  if (chunk === 0 && !logId) {
    const [logRow] = await sbInsert('screener_refresh_log', {
      tickers_attempted: universe.length,
      tickers_ok: 0,
      tickers_failed: 0,
      triggered_by: triggeredBy,
      notes: `chunk 0/${Math.ceil(universe.length / chunkSize) - 1} started`,
    });
    currentLogId = logRow.id;
  }

  // 4) Process this chunk with rate limiting
  const gate = roicRateLimiter(250);
  const rows = [];
  const failed = [];
  const timeoutAt = startedAt + HARD_TIMEOUT_MS;
  let processed = 0;

  for (const ticker of slice) {
    if (Date.now() > timeoutAt) {
      // Bail early, remaining tickers will go in next chunk
      break;
    }
    await gate();
    try {
      const row = await fetchTickerSnapshot(ticker);
      if (row) rows.push(row);
      else failed.push(ticker);
    } catch (e) {
      failed.push(ticker);
    }
    processed++;
  }

  // 5) Upsert batch (chunks of 100 to keep payload sane)
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(r => ({ ...r, updated_at: new Date().toISOString() }));
    if (batch.length) {
      await sbUpsert('screener_snapshot', batch, 'ticker');
    }
  }

  const totalChunks = Math.ceil(universe.length / chunkSize);
  const isLast = chunk >= totalChunks - 1;
  const nextChunk = isLast ? null : chunk + 1;

  // 6) Update log
  if (currentLogId) {
    const cur = await sbSelect('screener_refresh_log', `id=eq.${currentLogId}`);
    const okSoFar = (cur[0]?.tickers_ok || 0) + rows.length;
    const failSoFar = (cur[0]?.tickers_failed || 0) + failed.length;
    await sbUpdate('screener_refresh_log', `id=eq.${currentLogId}`, {
      tickers_ok: okSoFar,
      tickers_failed: failSoFar,
      finished_at: isLast ? new Date().toISOString() : null,
      notes: `chunk ${chunk}/${totalChunks - 1} done, ${processed}/${slice.length} processed, ${failed.length} failed`,
    });
  }

  return {
    ok: true,
    chunk,
    totalChunks,
    processed,
    upserted: rows.length,
    failed: failed.length,
    failedSample: failed.slice(0, 10),
    nextChunk,
    isLast,
    elapsedMs: Date.now() - startedAt,
    logId: currentLogId,
  };
}

module.exports = async (req, res) => {
  // Auth: cron header, vercel cron header, or explicit admin token
  const expected = process.env.CRON_SECRET;
  const cronHdrOk = !!expected && req.headers['x-cron-secret'] === expected;
  const isVercelCron =
    'x-vercel-cron-schedule' in req.headers ||
    (typeof req.headers['x-vercel-cron'] === 'string');

  if (!cronHdrOk && !isVercelCron) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const chunk = parseInt(req.query.chunk || '0', 10) || 0;
    const chunkSize = parseInt(req.query.chunk_size || String(DEFAULT_CHUNK_SIZE), 10) || DEFAULT_CHUNK_SIZE;
    const logId = req.query.log_id ? parseInt(req.query.log_id, 10) : null;

    const result = await runScreenerRefresh({ chunk, chunkSize, logId, triggeredBy: isVercelCron ? 'cron' : 'manual' });

    // If not last chunk, fire-and-forget the next chunk so a single cron
    // fires the whole chain. We reuse the same secret for the internal call.
    if (!result.isLast && result.nextChunk != null) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const nextUrl = `${proto}://${host}/api/cron/screener-refresh?chunk=${result.nextChunk}&chunk_size=${chunkSize}&log_id=${result.logId}`;
      // fire-and-forget
      fetch(nextUrl, { headers: { 'x-cron-secret': expected || '' } }).catch(() => {});
    }

    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
};

module.exports.runScreenerRefresh = runScreenerRefresh;
