// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Pipeline Cards CRUD (admin-only)
// ───────────────────────────────────────────────────────────────────
// All requests require x-admin-token (verifyAdminToken).
// Uses SUPABASE_SERVICE_ROLE_KEY → bypasses RLS.
//
//   GET    /api/admin/pipeline-cards
//          → { items: [...] }
//   POST   /api/admin/pipeline-cards
//          body: { ticker, name, stage?, note?, source_url? }
//          → { item: {...} }
//   PATCH  /api/admin/pipeline-cards?id=<uuid>
//          body: any subset of { stage, note, quality, valuation, irr, name }
//          → { item: {...} }
//   DELETE /api/admin/pipeline-cards?id=<uuid>
//          → { ok: true }
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');
const { sendStageChangeAlert } = require('../_notify');

const VALID_STAGES = ['backlog', 'analysis', 'review', 'decision', 'approved', 'rejected', 'invested', 'closed', 'passed'];

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const v = verifyAdminToken(tok, secret);
  if (!v) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return v.email || 'admin';
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'pipeline_cards',
        'select=*&order=moved_at.desc.nullslast,created_at.desc&limit=500'
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const ticker = (body.ticker || '').toString().toUpperCase().trim();
      const name = (body.name || '').toString().trim();
      const stage = (body.stage || 'backlog').toString().trim();
      const note = body.note ? String(body.note).trim() : null;

      if (!ticker || !/^[A-Z0-9.\-]{1,15}$/.test(ticker)) {
        res.status(400).json({ error: 'Invalid ticker' });
        return;
      }
      if (!name) {
        res.status(400).json({ error: 'Name required' });
        return;
      }
      if (!VALID_STAGES.includes(stage)) {
        res.status(400).json({ error: 'Invalid stage' });
        return;
      }

      const row = {
        ticker,
        name,
        stage,
        note,
        created_by: actor,
        updated_by: actor,
      };

      const result = await sbInsert('pipeline_cards', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }

      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }

      const patch = { updated_by: actor };
      if (body.stage !== undefined) {
        if (!VALID_STAGES.includes(body.stage)) {
          res.status(400).json({ error: 'Invalid stage' });
          return;
        }
        patch.stage = body.stage;
        patch.moved_at = new Date().toISOString();
      }
      if (body.note !== undefined) patch.note = body.note ? String(body.note).trim() : null;
      if (body.name !== undefined) {
        const nm = String(body.name).trim();
        if (!nm) { res.status(400).json({ error: 'Name cannot be empty' }); return; }
        patch.name = nm;
      }
      if (body.quality !== undefined) {
        const q = body.quality === null ? null : Number(body.quality);
        if (q !== null && !Number.isFinite(q)) { res.status(400).json({ error: 'Invalid quality' }); return; }
        patch.quality = q;
      }
      if (body.valuation !== undefined) {
        const v = body.valuation === null ? null : Number(body.valuation);
        if (v !== null && !Number.isFinite(v)) { res.status(400).json({ error: 'Invalid valuation' }); return; }
        patch.valuation = v;
      }
      if (body.irr !== undefined) patch.irr = body.irr ? String(body.irr).trim() : null;

      // Capture pre-update state if stage is changing (for email alert + diff).
      let prevCard = null;
      if (patch.stage !== undefined) {
        try {
          const prev = await sbSelect('pipeline_cards', `select=stage,ticker,name&id=eq.${id}&limit=1`);
          prevCard = Array.isArray(prev) && prev[0] ? prev[0] : null;
        } catch {}
      }

      const result = await sbUpdate('pipeline_cards', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      if (!item) {
        res.status(404).json({ error: 'Card not found' });
        return;
      }

      // Email alert when stage actually changes — must await before responding
      // because Vercel freezes the lambda after res.send (no background work).
      let alertResult = null;
      if (prevCard && patch.stage && prevCard.stage !== patch.stage) {
        try {
          alertResult = await sendStageChangeAlert({
            ticker: item.ticker || prevCard.ticker,
            name: item.name || prevCard.name,
            oldStage: prevCard.stage,
            newStage: patch.stage,
            actor,
            note: patch.note !== undefined ? patch.note : item.note,
          });
          console.log('[stage-alert]', JSON.stringify(alertResult));
        } catch (err) {
          console.error('[stage-alert] threw', err);
          alertResult = { ok: false, error: String(err).slice(0, 200) };
        }
      }

      res.status(200).json({ item, alert: alertResult });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      // Cascade: delete comments first (no FK cascade defined; safe to do manually)
      try { await sbDelete('comments', `card_id=eq.${id}`); } catch {}
      await sbDelete('pipeline_cards', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
