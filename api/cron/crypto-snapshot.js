// ═══════════════════════════════════════════════════════════════════
// Daily crypto snapshot cron
// ───────────────────────────────────────────────────────────────────
// GET /api/cron-crypto-snapshot
//   Called by Vercel Cron every day at 00:15 UTC (see vercel.json).
//   Fetches CoinGecko spot for every unique coingecko_id present in
//   public/crypto_positions.json and inserts one row per coin into
//   crypto_price_history with snapshot_date = yesterday (UTC).
//
// Idempotent: ON CONFLICT DO NOTHING on (coin_id, snapshot_date).
// Fires on demand too: GET with ?date=YYYY-MM-DD backfills that date
// from the /simple/price endpoint (only works for current day; older
// dates require /market_chart/range).
//
// Auth: gated by Vercel Cron secret via CRON_SECRET header.
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { sbUpsert } = require('../_supabase');
const { fetchCryptoPrices } = require('../_crypto-prices');

function readPublicJson(filename) {
  const candidates = [
    path.join(process.cwd(), 'public', filename),
    path.join(__dirname, '..', 'public', filename),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) { /* ignore */ }
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    // Vercel Cron sets Authorization: Bearer <CRON_SECRET>.
    const cronSecret = process.env.CRON_SECRET;
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (cronSecret && auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const crJson = readPublicJson('crypto_positions.json');
    if (!crJson || !Array.isArray(crJson.positions)) {
      res.status(500).json({ error: 'crypto_positions.json missing or malformed' });
      return;
    }

    // Yesterday (UTC) — the day whose close we're capturing. If ?date=YYYY-MM-DD
    // is passed (manual backfill), use that instead. Never in the future.
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayUTC = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const rawDate = (req.query && req.query.date) ? String(req.query.date) : yesterdayUTC;
    const snapshotDate =
      /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? (rawDate > today ? today : rawDate) : yesterdayUTC;

    const ids = Array.from(new Set(
      crJson.positions
        .filter(p => p.price_source && p.price_source.coingecko_id)
        .map(p => p.price_source.coingecko_id)
    ));
    if (ids.length === 0) {
      res.status(200).json({ ok: true, snapshot_date: snapshotDate, inserted: 0, note: 'no coingecko ids in positions' });
      return;
    }

    const priceResult = await fetchCryptoPrices(ids, 6000);
    if (!priceResult.ok) {
      res.status(502).json({ error: 'coingecko unavailable', detail: priceResult.error });
      return;
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Supabase env vars missing' });
      return;
    }

    const rows = [];
    const missing = [];
    for (const id of ids) {
      const px = priceResult.prices[id];
      if (px && px.last > 0) {
        rows.push({
          coin_id: id,
          snapshot_date: snapshotDate,
          price_usd: px.last,
          source: 'coingecko',
        });
      } else {
        missing.push(id);
      }
    }

    if (rows.length === 0) {
      res.status(200).json({ ok: false, snapshot_date: snapshotDate, inserted: 0, missing });
      return;
    }

    // Upsert with merge-duplicates; PostgREST needs a unique constraint on
    // (coin_id, snapshot_date) which the migration created.
    let inserted = [];
    try {
      inserted = await sbUpsert('crypto_price_history', rows, 'coin_id,snapshot_date');
    } catch (e) {
      res.status(500).json({ error: 'supabase upsert failed', detail: String(e && e.message || e) });
      return;
    }

    res.status(200).json({
      ok: true,
      snapshot_date: snapshotDate,
      inserted: (inserted || []).length,
      requested: rows.length,
      missing,
      coins: rows.map(r => ({ coin_id: r.coin_id, price_usd: r.price_usd })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
