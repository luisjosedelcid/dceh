// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Screener query endpoint
// GET /api/screener-query?mcap_min=1e9&sectors=Technology,Health%20Care&
//                        roic_min=15&gm_min=40&growth_min=5&dte_max=3
//                        &sort=roic_desc&limit=200
//
// Filters `screener_snapshot` by the standard MVP fields and returns
// rows ordered by the requested column.
//
// Requires an authenticated user with capability SC-01.
// ═══════════════════════════════════════════════════════════════════

const { requireCapability } = require('./_require-capability.js');
const { sbSelect } = require('./_supabase.js');

const SORT_MAP = {
  roic_desc: 'roic.desc.nullslast',
  roic_asc: 'roic.asc.nullslast',
  mcap_desc: 'market_cap.desc.nullslast',
  mcap_asc: 'market_cap.asc.nullslast',
  pe_asc: 'pe_ratio.asc.nullslast',
  pe_desc: 'pe_ratio.desc.nullslast',
  growth_desc: 'revenue_cagr_5y.desc.nullslast',
  gm_desc: 'gross_margin.desc.nullslast',
  ticker_asc: 'ticker.asc',
};

module.exports = async (req, res) => {
  const auth = await requireCapability(req, 'SC-01');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const q = req.query;
    const filters = [];

    // Market cap
    if (q.mcap_min) filters.push(`market_cap=gte.${Number(q.mcap_min)}`);
    if (q.mcap_max) filters.push(`market_cap=lte.${Number(q.mcap_max)}`);

    // Sectors (comma-separated)
    if (q.sectors) {
      const list = String(q.sectors).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) {
        const enc = list.map(s => `"${s.replace(/"/g, '\\"')}"`).join(',');
        filters.push(`sector=in.(${enc})`);
      }
    }

    // Profitability
    if (q.roic_min) filters.push(`roic=gte.${Number(q.roic_min)}`);
    if (q.gm_min) filters.push(`gross_margin=gte.${Number(q.gm_min)}`);
    if (q.om_min) filters.push(`operating_margin=gte.${Number(q.om_min)}`);

    // Growth
    if (q.growth_min) filters.push(`revenue_cagr_5y=gte.${Number(q.growth_min)}`);

    // Leverage
    if (q.dte_max) filters.push(`debt_to_ebitda=lte.${Number(q.dte_max)}`);

    // Valuation
    if (q.pe_max) filters.push(`pe_ratio=lte.${Number(q.pe_max)}`);
    if (q.ev_ebitda_max) filters.push(`ev_to_ebitda=lte.${Number(q.ev_ebitda_max)}`);

    // Sort + limit
    const sort = SORT_MAP[q.sort] || SORT_MAP.mcap_desc;
    const limit = Math.min(parseInt(q.limit || '200', 10) || 200, 500);

    // Select only what UI needs
    const cols = [
      'ticker', 'company_name', 'sector', 'industry', 'exchange',
      'price', 'market_cap',
      'roic', 'roe', 'gross_margin', 'operating_margin',
      'debt_to_ebitda', 'pe_ratio', 'ev_to_ebitda', 'price_to_book',
      'revenue_cagr_5y', 'revenue_ltm',
      'fiscal_year', 'as_of_date', 'updated_at',
    ].join(',');

    const params = new URLSearchParams();
    params.set('select', cols);
    params.set('order', sort);
    params.set('limit', String(limit));
    // Append filters (each is already key=op.value)
    for (const f of filters) {
      const [k, ...rest] = f.split('=');
      params.append(k, rest.join('='));
    }

    const rows = await sbSelect('screener_snapshot', params.toString());

    // Latest refresh timestamp (for the "Last snapshot: ..." UI hint)
    const meta = await sbSelect('screener_refresh_log', 'select=finished_at,tickers_ok,tickers_failed,triggered_by&order=started_at.desc&limit=1');

    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    res.status(200).json({
      rows,
      count: rows.length,
      snapshot: meta[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
