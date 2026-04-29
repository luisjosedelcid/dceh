// DCE Holdings — Decision Journal admin API
// GET    /api/admin/journal             → list all (active + inactive)
// POST   /api/admin/journal             → create (JSON body)
// PATCH  /api/admin/journal?id=N        → update (JSON body)
// DELETE /api/admin/journal?id=N        → soft-delete (set active=false)
// POST   /api/admin/journal?review=3m|6m|12m&id=N
//        → mark a review done with body { outcome, lesson_learned? }
//
// Auth: x-admin-token header

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate } = require('../_supabase');

const VALID_TYPES = ['BUY', 'SELL', 'PASS', 'HOLD', 'TRIM', 'ADD'];

function addMonths(dateStr, months) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

module.exports = async (req, res) => {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // ── Mark a review done ─────────────────────────
    if (req.method === 'POST' && req.query.review) {
      const id = parseInt(req.query.id || '', 10);
      const which = (req.query.review || '').toString();
      if (!Number.isFinite(id) || !['3m', '6m', '12m'].includes(which)) {
        res.status(400).json({ error: 'id and review (3m|6m|12m) required' });
        return;
      }
      const data = await readJson(req);
      const outcome = (data.outcome || '').toString().slice(0, 4000);
      if (!outcome) {
        res.status(400).json({ error: 'outcome required' });
        return;
      }
      const patch = {
        [`review_${which}_outcome`]: outcome,
        [`review_${which}_done_at`]: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (data.lesson_learned) {
        patch.lesson_learned = data.lesson_learned.toString().slice(0, 4000);
      }
      const updated = await sbUpdate('decision_journal', `id=eq.${id}`, patch);
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    // ── List all ───────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sbSelect('decision_journal', 'select=*&order=decision_date.desc,id.desc&limit=1000');
      res.status(200).json({ items: rows });
      return;
    }

    // ── Create ─────────────────────────────────────
    if (req.method === 'POST') {
      const data = await readJson(req);
      const ticker = (data.ticker || '').toString().toUpperCase().trim();
      const type = (data.decision_type || '').toString().toUpperCase().trim();
      const decisionDate = (data.decision_date || '').toString().trim();
      const thesis = (data.thesis || '').toString().trim();

      if (!ticker || ticker.length > 12) {
        res.status(400).json({ error: 'ticker required (max 12 chars)' });
        return;
      }
      if (!VALID_TYPES.includes(type)) {
        res.status(400).json({ error: `decision_type must be one of: ${VALID_TYPES.join(', ')}` });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) {
        res.status(400).json({ error: 'decision_date must be YYYY-MM-DD' });
        return;
      }
      if (!thesis) {
        res.status(400).json({ error: 'thesis required' });
        return;
      }

      const rec = {
        ticker,
        decision_type: type,
        decision_date: decisionDate,
        price_at_decision: data.price_at_decision != null && data.price_at_decision !== '' ? Number(data.price_at_decision) : null,
        thesis: thesis.slice(0, 8000),
        catalysts: Array.isArray(data.catalysts) ? data.catalysts.slice(0, 12).map(s => String(s).slice(0, 200)) : [],
        pre_mortem: (data.pre_mortem || '').toString().slice(0, 4000) || null,
        review_3m_date: addMonths(decisionDate, 3),
        review_6m_date: addMonths(decisionDate, 6),
        review_12m_date: addMonths(decisionDate, 12),
        linked_holding: (data.linked_holding || '').toString().slice(0, 200) || null,
        created_by: auth.email || null,
        active: true,
      };
      const created = await sbInsert('decision_journal', rec);
      res.status(200).json({ ok: true, item: Array.isArray(created) ? created[0] : created });
      return;
    }

    // ── Update ─────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      const data = await readJson(req);
      const patch = { updated_at: new Date().toISOString() };
      const allowed = [
        'ticker', 'decision_type', 'decision_date', 'price_at_decision',
        'thesis', 'catalysts', 'pre_mortem',
        'review_3m_date', 'review_6m_date', 'review_12m_date',
        'lesson_learned', 'linked_holding', 'active',
      ];
      for (const k of allowed) if (k in data) patch[k] = data[k];
      if (patch.ticker) patch.ticker = String(patch.ticker).toUpperCase().trim();
      if (patch.decision_type && !VALID_TYPES.includes(patch.decision_type)) {
        res.status(400).json({ error: 'invalid decision_type' });
        return;
      }
      const updated = await sbUpdate('decision_journal', `id=eq.${id}`, patch);
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    // ── Soft delete ────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      await sbUpdate('decision_journal', `id=eq.${id}`, { active: false, updated_at: new Date().toISOString() });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
