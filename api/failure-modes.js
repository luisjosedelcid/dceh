// POST  /api/failure-modes              — create failure mode (admin)
//   body: { premortem_id, failure_mode, category, trigger_type, trigger_config, probability_pct, severity_pct, notes }
// PATCH /api/failure-modes?id=N         — update fields (admin) — used to flip status (qualitative_manual), edit notes/probability
//   body: { status?, notes?, probability_pct?, severity_pct?, trigger_config? }

'use strict';

const { sbInsert, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');

const VALID_CATEGORIES = ['business','financial','management','macro','valuation','risk'];
const VALID_TRIGGER_TYPES = ['quantitative','qualitative_llm','qualitative_manual'];
const VALID_STATUS = ['monitoring','triggered','resolved','invalidated'];

module.exports = async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const body = await readJsonBody(req);
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);

    if (method === 'POST') {
      const premortem_id = Number(body.premortem_id);
      const failure_mode = String(body.failure_mode || '').trim();
      if (!premortem_id || !failure_mode) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'premortem_id and failure_mode required' }));
        return;
      }
      const category = String(body.category || 'risk');
      const trigger_type = String(body.trigger_type || 'qualitative_manual');
      if (!VALID_CATEGORIES.includes(category)) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'invalid category' })); return;
      }
      if (!VALID_TRIGGER_TYPES.includes(trigger_type)) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'invalid trigger_type' })); return;
      }

      const row = {
        premortem_id,
        failure_mode,
        category,
        trigger_type,
        trigger_config: body.trigger_config || {},
        probability_pct: body.probability_pct != null ? Number(body.probability_pct) : null,
        severity_pct: body.severity_pct != null ? Number(body.severity_pct) : null,
        status: 'monitoring',
        notes: body.notes || null,
        created_by: auth.user.email,
      };
      const inserted = await sbInsert('failure_modes', row);
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, failure_mode: inserted[0] }));
      return;
    }

    if (method === 'PATCH' || method === 'PUT') {
      const id = Number(url.searchParams.get('id') || body.id);
      if (!id) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'id required' })); return;
      }
      const patch = {};
      if (body.status != null) {
        if (!VALID_STATUS.includes(body.status)) {
          res.status(400).end(JSON.stringify({ ok: false, error: 'invalid status' })); return;
        }
        patch.status = body.status;
        if (body.status === 'triggered') {
          patch.triggered_at = new Date().toISOString();
        }
      }
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.probability_pct !== undefined) patch.probability_pct = Number(body.probability_pct);
      if (body.severity_pct !== undefined) patch.severity_pct = Number(body.severity_pct);
      if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config;
      patch.updated_at = new Date().toISOString();

      const updated = await sbUpdate('failure_modes', `id=eq.${id}`, patch);
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, failure_mode: updated[0] }));
      return;
    }

    res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
