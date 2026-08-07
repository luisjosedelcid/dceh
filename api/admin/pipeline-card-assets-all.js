// GET /api/admin/pipeline-card-assets-all
// Returns all active deliverables across every card (no signed URLs \u2014 for badges).
// Auth: admin or analyst.

const { requireCapability } = require('../_require-capability');
const { sbSelect } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireCapability(req, 'PL-07');
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  try {
    const items = await sbSelect(
      'pipeline_card_assets',
      `select=id,card_id,ticker,kind,filename,size_bytes,uploaded_at&active=eq.true&limit=2000`
    );
    res.status(200).json({ items });
  } catch (e) {
    res.status(500).json({ error: 'List failed', detail: String(e).slice(0, 200) });
  }
};
