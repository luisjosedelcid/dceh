// Cron — daily portfolio snapshot. Runs ~22:30 UTC after prices-refresh (22:00 UTC).
// Recomputes the full series (cheap) and upserts. Idempotent.
const { sbUpsert } = require('../_supabase');
const { loadAndCompute } = require('../_perf-load');

module.exports = async (req, res) => {
  try {
    // Auth: Vercel cron secret
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.status(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const result = await loadAndCompute({});
    const series = result.dailySeries || [];
    if (series.length === 0) {
      res.status(200).end(JSON.stringify({ ok: true, written: 0, message: 'No data' }));
      return;
    }

    const rows = series.map(d => ({
      snapshot_date: d.date,
      nav_usd: d.nav,
      invested_usd: null,
      cash_usd: d.cash,
      twr_daily: d.twr_daily,
      twr_cumulative: d.twr_cum,
      benchmark_urth: d.urth_norm,
      drawdown_pct: d.drawdown,
      holdings_json: null,
    }));
    rows[rows.length - 1].holdings_json = result.holdings;

    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sbUpsert('portfolio_snapshots', chunk, 'snapshot_date');
      written += chunk.length;
    }

    res.status(200).end(JSON.stringify({ ok: true, written, last_date: series[series.length - 1].date }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
