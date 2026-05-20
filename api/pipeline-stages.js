// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Public read-only endpoint for pipeline stages
// ───────────────────────────────────────────────────────────────────
// Returns { items: [{ ticker, stage }] } so any public page (e.g.
// /universe.html) can map kanban stage → funnel tab without admin auth.
//
//   GET /api/pipeline-stages
//        → { items: [{ ticker, stage }] }
//
// Source of truth: pipeline_cards.stage in Supabase.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const items = await sbSelect(
      'pipeline_cards',
      'select=ticker,stage&order=ticker.asc&limit=500'
    );
    // Short cache: stages change rarely; keeps the page snappy.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ items });
  } catch (e) {
    console.error('pipeline-stages error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
};
