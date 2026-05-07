// DCE Holdings — Decision Journal write API (admin-only)
// POST /api/journal-create
// Header: x-admin-token: <token>
//
// Body: {
//   ticker:           "BKNG"        (required, uppercased)
//   decision_type:    "BUY"|"PASS"|"SELL"|"HOLD"|"TRIM"|"ADD"  (required)
//   decision_date:    "2026-05-07"  (required, ISO date)
//   thesis:           "..."         (required, free text)
//   price_at_decision: 4521.30      (optional, numeric)
//   catalysts:        ["..","..."]  (optional, array of strings)
//   pre_mortem:       "..."         (optional, free text — for quick draft)
//   notes:            "..."         (optional, appended to thesis if present)
// }
//
// Returns: { ok: true, item: { ...inserted row... } }
//
// Notes:
//   - Light-weight registration. Skills (dce-decision-buy/pass/sell) still own
//     enrichment: full pre-mortem with failure_modes, pipeline transitions,
//     trade execution, portfolio sync, post-mortem on SELL.
//   - This endpoint just creates the decision_journal row so the CIO can
//     register a decision from the UI without going through chat.

const { sbInsert } = require('./_supabase');
const { requireRole } = require('./_require-role');
const pipelineStage = require('./_pipeline-stage');
const { archivePremortemForTicker } = require('./_premortem-archive');

const VALID_TYPES = new Set(['BUY', 'PASS', 'SELL', 'HOLD', 'TRIM', 'ADD']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status || 401).json({ error: auth.error || 'Unauthorized' });
      return;
    }

    const body = req.body || {};
    const ticker = (body.ticker || '').toString().toUpperCase().trim();
    const decision_type = (body.decision_type || '').toString().toUpperCase().trim();
    const decision_date = (body.decision_date || '').toString().trim();
    const thesis = (body.thesis || '').toString().trim();

    // Validations
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      return res.status(400).json({ error: 'ticker invalid (uppercase letters/digits, max 10)' });
    }
    if (!VALID_TYPES.has(decision_type)) {
      return res.status(400).json({
        error: `decision_type must be one of ${[...VALID_TYPES].join(', ')}`,
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decision_date)) {
      return res.status(400).json({ error: 'decision_date must be YYYY-MM-DD' });
    }
    if (!thesis || thesis.length < 10) {
      return res.status(400).json({ error: 'thesis is required (min 10 chars)' });
    }
    if (thesis.length > 8000) {
      return res.status(400).json({ error: 'thesis too long (max 8000 chars)' });
    }

    // Optional fields
    let price_at_decision = null;
    if (body.price_at_decision != null && body.price_at_decision !== '') {
      const n = Number(body.price_at_decision);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'price_at_decision must be a non-negative number' });
      }
      price_at_decision = n;
    }

    let catalysts = null;
    if (Array.isArray(body.catalysts)) {
      catalysts = body.catalysts
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter((c) => c.length > 0)
        .slice(0, 20); // hard cap
    }

    const pre_mortem = body.pre_mortem ? String(body.pre_mortem).trim().slice(0, 8000) : null;
    const notes = body.notes ? String(body.notes).trim() : '';

    // Append notes to thesis (separator) if both provided
    let finalThesis = thesis;
    if (notes) {
      finalThesis = `${thesis}\n\n— Notes —\n${notes}`;
      if (finalThesis.length > 10000) finalThesis = finalThesis.slice(0, 10000);
    }

    // Auto-compute review dates for BUY (3m / 6m / 12m)
    let review_3m = null, review_6m = null, review_12m = null;
    if (decision_type === 'BUY') {
      const d = new Date(decision_date + 'T00:00:00Z');
      const addMonths = (date, m) => {
        const x = new Date(date.getTime());
        x.setUTCMonth(x.getUTCMonth() + m);
        return x.toISOString().slice(0, 10);
      };
      review_3m = addMonths(d, 3);
      review_6m = addMonths(d, 6);
      review_12m = addMonths(d, 12);
    }

    const row = {
      ticker,
      decision_type,
      decision_date,
      price_at_decision,
      thesis: finalThesis,
      catalysts: catalysts && catalysts.length ? catalysts : null,
      pre_mortem,
      review_3m_date: review_3m,
      review_6m_date: review_6m,
      review_12m_date: review_12m,
      created_by: auth.user.email,
      active: true,
    };

    const inserted = await sbInsert('decision_journal', row);
    const item = Array.isArray(inserted) ? inserted[0] : inserted;

    // ---- Workflow side-effects --------------------------------------------
    // The journal entry IS the lifecycle event for the position card.
    //   BUY / ADD  -> invested
    //   PASS       -> passed
    //   SELL       -> closed (and pre-mortem is archived, failure modes invalidated)
    //   HOLD / TRIM -> no transition (informational entries)
    // All side-effects are best-effort: failures are logged but never break
    // the primary insert. Detailed status is returned to the client for visibility.
    let stageSync = null;
    let archive = null;
    try {
      if (decision_type === 'BUY' || decision_type === 'ADD') {
        stageSync = await pipelineStage.onBuyDecision(ticker);
      } else if (decision_type === 'PASS') {
        stageSync = await pipelineStage.onPassDecision(ticker);
      } else if (decision_type === 'SELL') {
        stageSync = await pipelineStage.onSellDecision(ticker);
        try {
          archive = await archivePremortemForTicker(ticker);
        } catch (eArc) {
          console.error('[journal-create] archivePremortem failed:', eArc.message);
          archive = { error: eArc.message };
        }
      }
    } catch (eSync) {
      console.warn('[journal-create] pipeline transition failed:', eSync.message);
      stageSync = { ok: false, error: eSync.message };
    }

    res.status(200).json({ ok: true, item, stageSync, archive });
  } catch (e) {
    console.error('[journal-create] error:', e);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
};
