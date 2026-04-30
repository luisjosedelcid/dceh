// GET  /api/premortems                — list active premortems (with failure_modes)
// GET  /api/premortems?ticker=MSFT    — filter by ticker
// POST /api/premortems                — create premortem (admin) { ticker, thesis_summary, notes }
//
// Read endpoints: any authenticated user (analyst+admin).
// Write endpoints: admin only.

'use strict';

const { sbSelect, sbInsert } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();

    // ── GET: list ───────────────────────────────────────────────────────────
    if (method === 'GET') {
      const auth = await requireRole(req, ['any']);
      if (!auth.ok) {
        res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
      const ticker = (url.searchParams.get('ticker') || '').trim().toUpperCase();
      const includeArchived = url.searchParams.get('include_archived') === '1';

      let q = 'select=id,ticker,status,thesis_summary,notes,created_at,created_by,updated_at&order=ticker.asc';
      if (!includeArchived) q += '&status=eq.active';
      if (ticker) q += `&ticker=eq.${encodeURIComponent(ticker)}`;

      const pms = await sbSelect('premortems', q);
      if (pms.length === 0) {
        res.setHeader('content-type', 'application/json');
        res.status(200).end(JSON.stringify({ ok: true, premortems: [] }));
        return;
      }

      const ids = pms.map(p => p.id).join(',');
      const fms = await sbSelect(
        'failure_modes',
        `select=id,premortem_id,failure_mode,category,trigger_type,trigger_config,probability_pct,severity_pct,status,triggered_at,last_evaluated_at,notes,created_at,updated_at&premortem_id=in.(${ids})&order=premortem_id.asc,id.asc`
      );

      // Group failure_modes by premortem_id
      const byPm = new Map(pms.map(p => [p.id, []]));
      for (const fm of fms) {
        if (byPm.has(fm.premortem_id)) byPm.get(fm.premortem_id).push(fm);
      }

      // For each failure_mode, also pull last 1 evaluation for evidence freshness
      const fmIds = fms.map(f => f.id);
      const lastEvals = new Map();
      if (fmIds.length > 0) {
        const evals = await sbSelect(
          'trigger_evaluations',
          `select=failure_mode_id,evaluated_at,status,observed_value,threshold_value,evidence_text&failure_mode_id=in.(${fmIds.join(',')})&order=evaluated_at.desc&limit=1000`
        );
        for (const ev of evals) {
          if (!lastEvals.has(ev.failure_mode_id)) lastEvals.set(ev.failure_mode_id, ev);
        }
      }

      const out = pms.map(p => ({
        ...p,
        failure_modes: (byPm.get(p.id) || []).map(fm => ({
          ...fm,
          last_evaluation: lastEvals.get(fm.id) || null,
        })),
        triggered_count: (byPm.get(p.id) || []).filter(fm => fm.status === 'triggered').length,
        total_count: (byPm.get(p.id) || []).length,
      }));

      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, premortems: out }));
      return;
    }

    // ── POST: create premortem (admin only) ─────────────────────────────────
    if (method === 'POST') {
      const auth = await requireRole(req, ['admin']);
      if (!auth.ok) {
        res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
        return;
      }

      const body = await readJsonBody(req);
      const ticker = String(body.ticker || '').trim().toUpperCase();
      if (!ticker) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'ticker required' }));
        return;
      }

      const row = {
        ticker,
        status: 'active',
        thesis_summary: body.thesis_summary || null,
        notes: body.notes || null,
        created_by: auth.user.email,
      };
      const inserted = await sbInsert('premortems', row);
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, premortem: inserted[0] }));
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
