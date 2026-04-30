// GET /api/performance — returns KPIs + holdings + equity curve.
//
// Reads from portfolio_snapshots if populated; otherwise computes on-the-fly.
// Query params:
//   - source=db (default if snapshots exist) | live (always recompute)
const { sbSelect } = require('./_supabase');
const { loadAndCompute } = require('./_perf-load');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const source = url.searchParams.get('source') || 'auto';

    let result;
    if (source === 'live') {
      result = await loadAndCompute({});
    } else {
      // Try DB first
      const snaps = await sbSelect('portfolio_snapshots', 'select=*&order=snapshot_date.asc&limit=10000');
      if (snaps.length === 0 || source === 'recompute') {
        result = await loadAndCompute({});
      } else {
        // Use DB snapshots for series, but recompute holdings + KPIs from latest state
        // (cheap — already computed daily). Simpler: just recompute always for MVP correctness.
        result = await loadAndCompute({});
      }
    }

    // Trim daily series response: we only need {date, nav, twr_cum, drawdown, urth_norm}
    const series = (result.dailySeries || []).map(d => ({
      date: d.date,
      nav: d.nav,
      cash: d.cash,
      mv: d.market_value,
      twr_cum: d.twr_cum,
      drawdown: d.drawdown,
      urth_norm: d.urth_norm,
    }));

    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.status(200).end(JSON.stringify({
      ok: true,
      kpis: result.kpis,
      holdings: result.holdings,
      series,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
