// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Idea Feed public read API
// GET /api/idea-feed?days=14&ticker=AAPL&source_id=3
//   Returns { items, sources, last_refresh_at }
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('./_supabase.js');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const days = Math.min(parseInt(req.query.days || '21', 10) || 21, 90);
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    const sourceId = parseInt(req.query.source_id || '', 10);

    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

    let q = `select=id,source_id,url,title,snippet,published_at,tickers,extraction_method,thesis,fetched_at`;
    q += `&order=published_at.desc.nullslast,fetched_at.desc&limit=300`;
    q += `&or=(published_at.gte.${since},and(published_at.is.null,fetched_at.gte.${since}))`;
    if (Number.isFinite(sourceId)) q += `&source_id=eq.${sourceId}`;
    if (ticker) q += `&tickers=cs.{${ticker}}`;

    const [items, sources] = await Promise.all([
      sbSelect('idea_feed_items', q),
      sbSelect('idea_feed_sources', 'select=id,name,url,kind,is_paid,active&order=name.asc'),
    ]);

    const lastRefresh = items
      .map(i => i.fetched_at)
      .filter(Boolean)
      .sort()
      .pop() || null;

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).json({ items, sources, last_refresh_at: lastRefresh });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
