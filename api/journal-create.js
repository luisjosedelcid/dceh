// DCE Holdings — Decision Journal write API (admin-only)
// POST /api/journal-create
// Header: x-admin-token: <token>
//
// Body: {
//   ticker:           "BKNG"        (required, uppercased)
//   decision_type:    "BUY"|"PASS"|"FOLLOW"  (required)
//                     ADD/HOLD/TRIM/SELL are NOT accepted here — those are
//                     derived entries created automatically from re-underwriting
//                     submissions (see /api/reunderwriting-submit).
//                     FOLLOW = committee decides to keep the company on the
//                     watchlist after research (dual of PASS).
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

// Manual decision entries are restricted to BUY, PASS and FOLLOW — the three
// outcomes that originate from a fresh research package (Columbia + Memo +
// Munger). ADD / HOLD / TRIM / SELL are derived from re-underwriting outcomes
// and are inserted server-side by /api/reunderwriting-submit, never via this
// endpoint.
const VALID_TYPES = new Set(['BUY', 'PASS', 'FOLLOW']);

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

    // Analyst who did the research — optional but strongly encouraged.
    // Accepts a UUID that must exist in `analysts` (validated at FK level;
    // an invalid UUID would surface as a Supabase error, which is caught
    // below and returned to the client verbatim).
    let analyst_id = null;
    if (body.analyst_id) {
      const raw = String(body.analyst_id).trim();
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)) {
        analyst_id = raw;
      }
    }

    // ---- PASS reason fields (only accepted when decision_type === 'PASS') -----
    // Category + reconsideration trigger + how deep the study went. Category
    // and depth are enums, reconsideration is free text (empty means 'never').
    let pass_reason_category = null;
    let pass_reconsider_if = null;
    let pass_studied_depth = null;
    if (decision_type === 'PASS') {
      const CAT = ['price', 'quality', 'circle_of_competence', 'better_idea', 'structural', 'timing_macro'];
      const DEPTH = ['screener', 'quick_review', 'deep_dive'];
      if (body.pass_reason_category) {
        const c = String(body.pass_reason_category).trim().toLowerCase();
        if (!CAT.includes(c)) {
          return res.status(400).json({ error: `pass_reason_category must be one of: ${CAT.join('|')}` });
        }
        pass_reason_category = c;
      }
      if (body.pass_reconsider_if) {
        pass_reconsider_if = String(body.pass_reconsider_if).trim().slice(0, 2000) || null;
      }
      if (body.pass_studied_depth) {
        const d = String(body.pass_studied_depth).trim().toLowerCase();
        if (!DEPTH.includes(d)) {
          return res.status(400).json({ error: `pass_studied_depth must be one of: ${DEPTH.join('|')}` });
        }
        pass_studied_depth = d;
      }
    }

    // ---- FOLLOW watchlist fields (only accepted when decision_type === 'FOLLOW') -----
    // These describe how the follow should be managed: what event triggers a
    // move to action, at what price it becomes a BUY, until when it stays on
    // the watchlist, why it isn't a BUY today, and its relative priority.
    let follow_trigger = null;
    let follow_target_price = null;
    let follow_watch_until = null;
    let follow_blocker = null;
    let follow_priority = null;
    if (decision_type === 'FOLLOW') {
      if (body.follow_trigger) {
        follow_trigger = String(body.follow_trigger).trim().slice(0, 2000) || null;
      }
      if (body.follow_target_price !== undefined && body.follow_target_price !== null && body.follow_target_price !== '') {
        const n = Number(body.follow_target_price);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: 'follow_target_price must be a non-negative number' });
        }
        follow_target_price = n;
      }
      if (body.follow_watch_until) {
        const raw = String(body.follow_watch_until).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return res.status(400).json({ error: 'follow_watch_until must be YYYY-MM-DD' });
        }
        follow_watch_until = raw;
      }
      if (body.follow_blocker) {
        follow_blocker = String(body.follow_blocker).trim().slice(0, 2000) || null;
      }
      if (body.follow_priority) {
        const p = String(body.follow_priority).trim().toLowerCase();
        if (!['high', 'med', 'low'].includes(p)) {
          return res.status(400).json({ error: 'follow_priority must be high|med|low' });
        }
        follow_priority = p;
      }
    }

    // ---- v3.2 fields (only meaningful for BUY/ADD, but accepted for any type) -----
    // All optional. Plain text helpers + JSONB structures coming from the
    // Munger Digital v3.2 package (decision_inputs.json) or filled manually.
    const v32 = {};
    const txt = (k, max = 4000) => {
      if (body[k] == null || body[k] === '') return;
      v32[k] = String(body[k]).trim().slice(0, max);
    };
    const num = (k) => {
      if (body[k] == null || body[k] === '') return;
      const n = Number(body[k]);
      if (Number.isFinite(n)) v32[k] = n;
    };
    const json = (k) => {
      if (body[k] == null) return;
      // Accept either an already-parsed value or a JSON string
      let v = body[k];
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return;
        try { v = JSON.parse(s); } catch (_) { return; }
      }
      // Hard cap on serialized size to keep rows reasonable (~64KB each).
      try {
        const ser = JSON.stringify(v);
        if (ser.length > 65536) return;
      } catch (_) { return; }
      v32[k] = v;
    };

    // Scalar / text columns
    txt('framework_version', 16);
    txt('sector', 100);
    txt('industry', 100);
    txt('investment_horizon', 60);
    txt('conviction_level', 40);
    txt('position_size_band', 80);
    txt('reviewer', 200);
    txt('decision_owner', 200);
    txt('variant_perception', 8000);
    txt('executive_summary', 12000);
    txt('final_recommendation', 8000);
    txt('position_sizing_rationale', 8000);
    num('current_price');
    num('market_cap_usd_b');
    num('enterprise_value_usd_b');
    num('position_size_target_pct');

    // JSONB columns
    json('thesis_pillars');
    json('variant_evidence');
    json('business_quality');
    json('value_drivers');
    json('kpi_framework');
    json('expected_return');
    json('catalysts_v32');
    json('failure_modes');
    json('kill_criteria_v32');

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
      analyst_id,
      follow_trigger,
      follow_target_price,
      follow_watch_until,
      follow_blocker,
      follow_priority,
      pass_reason_category,
      pass_reconsider_if,
      pass_studied_depth,
      created_by: auth.user.email,
      active: true,
      ...v32,
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
      } else if (decision_type === 'FOLLOW') {
        stageSync = await pipelineStage.onFollowDecision(ticker);
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
