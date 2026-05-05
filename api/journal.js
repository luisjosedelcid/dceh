// DCE Holdings — Decision Journal read API (authenticated)
// GET /api/journal?ticker=XYZ&type=BUY&year=2026
// Header: x-admin-token: <token>
// Returns { items: [...], stats: {...}, pending_reviews: [...] }
//
// Restricted: decision_journal contains proprietary investment thesis,
// failure modes and lessons learned — never expose without auth.

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status || 401).json({ error: auth.error || 'Unauthorized' });
      return;
    }
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    const type = (req.query.type || '').toString().toUpperCase().trim();
    const year = parseInt(req.query.year || '', 10);

    let q = `select=*&active=eq.true&order=decision_date.desc,id.desc&limit=500`;
    if (ticker) q += `&ticker=eq.${encodeURIComponent(ticker)}`;
    if (['BUY', 'SELL', 'PASS', 'HOLD', 'TRIM', 'ADD'].includes(type)) {
      q += `&decision_type=eq.${type}`;
    }
    if (Number.isFinite(year) && year > 2000 && year < 3000) {
      q += `&decision_date=gte.${year}-01-01&decision_date=lte.${year}-12-31`;
    }

    const items = await sbSelect('decision_journal', q);

    // Stats from full set (not filtered)
    const allRows = (ticker || type || year)
      ? await sbSelect('decision_journal', 'select=decision_type,review_3m_date,review_6m_date,review_12m_date,review_3m_done_at,review_6m_done_at,review_12m_done_at&active=eq.true&limit=2000')
      : items;

    const stats = {
      total: allRows.length,
      buy: allRows.filter(r => r.decision_type === 'BUY').length,
      sell: allRows.filter(r => r.decision_type === 'SELL').length,
      pass: allRows.filter(r => r.decision_type === 'PASS').length,
      hold: allRows.filter(r => r.decision_type === 'HOLD').length,
      trim: allRows.filter(r => r.decision_type === 'TRIM').length,
      add: allRows.filter(r => r.decision_type === 'ADD').length,
    };

    // Pending reviews (review date in past + not yet done)
    const today = new Date().toISOString().slice(0, 10);
    const pending = allRows.filter(r => {
      const d3 = r.review_3m_date && r.review_3m_date <= today && !r.review_3m_done_at;
      const d6 = r.review_6m_date && r.review_6m_date <= today && !r.review_6m_done_at;
      const d12 = r.review_12m_date && r.review_12m_date <= today && !r.review_12m_done_at;
      return d3 || d6 || d12;
    }).length;
    stats.pending_reviews = pending;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json({
      items,
      stats,
      types: ['BUY', 'SELL', 'PASS', 'HOLD', 'TRIM', 'ADD'],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
