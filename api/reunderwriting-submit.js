// POST /api/reunderwriting-submit
//   Body: {
//     due_id: <number>,
//     thesis_still_valid: <text>,
//     kill_criteria_concern: <text|null>,
//     action: 'buy_more'|'hold'|'trim'|'sell',
//     action_reason: <text|null>,
//     price_at_review: <number|null>
//   }
//
// Behavior:
//   1. Loads the reunderwriting_due row (validates exists + still pending)
//   2. Snapshots the current failure_modes status for the ticker into kill_criteria_snapshot
//   3. Inserts row into reunderwriting_entries
//   4. Marks the due row as 'done' with entry_id + completed_at
//   5. Returns { ok, entry_id, due_id }
//
// Auth: admin only (re-underwriting is a CIO decision, not analyst).

'use strict';

const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');

const VALID_ACTIONS = new Set(['buy_more', 'hold', 'trim', 'sell']);

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const body = await readJsonBody(req);
    const dueId = Number(body.due_id);
    const thesisText = String(body.thesis_still_valid || '').trim();
    const action = String(body.action || '').trim();
    const killConcern = body.kill_criteria_concern ? String(body.kill_criteria_concern).trim() : null;
    const actionReason = body.action_reason ? String(body.action_reason).trim() : null;
    const priceAtReview = body.price_at_review != null ? Number(body.price_at_review) : null;

    if (!dueId) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'due_id required' }));
      return;
    }
    if (!thesisText || thesisText.length < 10) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'thesis_still_valid required (min 10 chars)' }));
      return;
    }
    if (!VALID_ACTIONS.has(action)) {
      res.status(400).end(JSON.stringify({ ok: false, error: `action must be one of: ${Array.from(VALID_ACTIONS).join(', ')}` }));
      return;
    }

    // 1. Validate due row
    const dues = await sbSelect('reunderwriting_due', `select=*&id=eq.${dueId}&limit=1`);
    if (dues.length === 0) {
      res.status(404).end(JSON.stringify({ ok: false, error: 'due_id not found' }));
      return;
    }
    const due = dues[0];
    if (due.status !== 'pending') {
      res.status(409).end(JSON.stringify({ ok: false, error: `due is already ${due.status}` }));
      return;
    }

    // 2. Snapshot failure_modes for this ticker (PostgREST cannot do subselects,
    //    so we do two roundtrips: premortem ids -> failure modes).
    const pms = await sbSelect('premortems', `select=id&ticker=eq.${due.ticker}&status=eq.active`);
    let killSnapshot = [];
    if (pms.length > 0) {
      const pmIds = pms.map(p => p.id).join(',');
      killSnapshot = await sbSelect(
        'failure_modes',
        `select=id,failure_mode,category,trigger_type,status,probability_pct,severity_pct,triggered_at&premortem_id=in.(${pmIds})&order=id.asc`
      );
    }

    // 3. Insert reunderwriting_entries
    const inserted = await sbInsert('reunderwriting_entries', [{
      due_id: due.id,
      ticker: due.ticker,
      period_end: due.period_end,
      thesis_still_valid: thesisText,
      kill_criteria_snapshot: killSnapshot,
      kill_criteria_concern: killConcern,
      action,
      action_reason: actionReason,
      price_at_review: priceAtReview,
      reviewer_email: auth.user.email,
    }]);
    const entry = Array.isArray(inserted) ? inserted[0] : inserted;

    // 4. Mark due as done
    await sbUpdate('reunderwriting_due', `id=eq.${due.id}`, {
      status: 'done',
      completed_at: new Date().toISOString(),
      entry_id: entry.id,
    });

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      entry_id: entry.id,
      due_id: due.id,
      ticker: due.ticker,
      period_end: due.period_end,
      action,
    }));
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
