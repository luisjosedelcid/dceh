// ═══════════════════════════════════════════════════════════════════
// POST /api/admin/pipeline-mirror-backfill
//   → Mirrors every currently-active pipeline_card_assets row that
//     has no mirror_id into the Data Room (06 Research).
//   Admin-only. Idempotent.
// ═══════════════════════════════════════════════════════════════════

const { requireCapability } = require('../_require-capability');
const { sbSelect } = require('../_supabase');
const { mirrorPipelineToDataroom } = require('../_pipeline_dataroom_mirror');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireCapability(req, 'SY-05');
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rows = await sbSelect(
      'pipeline_card_assets',
      'select=*&active=eq.true&mirror_id=is.null&limit=200'
    );
    const results = [];
    for (const row of (rows || [])) {
      try {
        const mid = await mirrorPipelineToDataroom(row);
        results.push({ id: row.id, ticker: row.ticker, kind: row.kind, mirror_id: mid, ok: !!mid });
      } catch (e) {
        results.push({ id: row.id, ticker: row.ticker, kind: row.kind, ok: false, error: String(e).slice(0, 200) });
      }
    }
    res.status(200).json({ processed: results.length, results });
  } catch (e) {
    res.status(500).json({ error: 'Backfill failed', detail: String(e).slice(0, 200) });
  }
};
