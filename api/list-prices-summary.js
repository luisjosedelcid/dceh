// GET /api/list-prices-summary
// Returns one row per ticker with row count, date range, last close, and source.
// Admin or analyst can read.

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    // Pull every row (small dataset for now). Later we can do a server-side aggregate via RPC.
    const rows = await sbSelect('prices_daily', 'select=ticker,price_date,close_native,source&order=ticker.asc,price_date.desc&limit=10000');

    // Group by ticker
    const byTicker = new Map();
    for (const r of rows) {
      const k = r.ticker;
      if (!byTicker.has(k)) {
        byTicker.set(k, {
          ticker: k,
          rows: 0,
          first_date: r.price_date,
          last_date: r.price_date,
          last_close: Number(r.close_native),
          source: r.source,
        });
      }
      const o = byTicker.get(k);
      o.rows += 1;
      if (r.price_date < o.first_date) o.first_date = r.price_date;
      if (r.price_date > o.last_date)  { o.last_date = r.price_date; o.last_close = Number(r.close_native); }
    }

    const tickers = Array.from(byTicker.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
    res.status(200).json({ ok: true, tickers });
  } catch (e) {
    res.status(500).json({ error: 'Query failed', detail: String(e).slice(0, 300) });
  }
};
