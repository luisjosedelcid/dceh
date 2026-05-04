// POST /api/admin-backfill-snapshots — recomputes the full daily series and upserts
// every row into portfolio_snapshots. Requires admin role.
const { requireRole } = require('./_require-role');
const { sbUpsert } = require('./_supabase');
const { loadAndCompute } = require('./_perf-load');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const result = await loadAndCompute({});
    const series = result.dailySeries || [];
    if (series.length === 0) {
      res.status(200).end(JSON.stringify({ ok: true, written: 0, message: 'No data to snapshot' }));
      return;
    }

    // Build snapshot rows
    const peakSoFar = { v: 0 };
    const rows = series.map(d => {
      // Recompute drawdown vs running peak (already in d.drawdown)
      return {
        snapshot_date: d.date,
        nav_usd: d.nav,
        invested_usd: null,        // could track separately if needed; nullable
        cash_usd: d.cash,
        twr_daily: d.twr_daily,
        twr_cumulative: d.twr_cum,
        benchmark_iwqu: d.iwqu_norm,
        drawdown_pct: d.drawdown,
        holdings_json: null,       // only fill final day's holdings — see below
      };
    });
    // Attach holdings JSON to last row
    if (rows.length > 0) {
      rows[rows.length - 1].holdings_json = result.holdings;
    }

    // Batch upsert in chunks of 500
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sbUpsert('portfolio_snapshots', chunk, 'snapshot_date');
      written += chunk.length;
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      written,
      first_date: series[0].date,
      last_date: series[series.length - 1].date,
      kpis: result.kpis,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
