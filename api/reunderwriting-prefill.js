// DCE Holdings — Re-Underwriting Prefill API
//
// GET /api/reunderwriting-prefill?ticker=MSFT[&due_id=N]
//
// Returns the data needed to prefill the v3.2 Re-Underwriting modal:
//   1) Active BUY entry from decision_journal (pillars, failure_modes,
//      kill_criteria_v32, position_size_target_pct, conviction_level,
//      analyst, decision_owner, framework_version, memo metadata).
//   2) Last completed reunderwriting_entries row for the ticker (used as
//      "previous quarter baseline" for what_changed delta + tracking carry-over).
//   3) Active premortem failure_modes (so the premortem_tracking section can
//      enumerate the canonical list of failure modes to evaluate).
//
// Public read — same pattern as /api/journal-check and
// /api/journal-decision-inputs. No sensitive data exposed.

'use strict';

const { sbSelect } = require('./_supabase');

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function badTicker(t) {
  return !t || !TICKER_RE.test(t);
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }
  return v;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
    if (badTicker(ticker)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_ticker' }));
    }
    const dueIdRaw = url.searchParams.get('due_id');
    const dueId = dueIdRaw ? Number(dueIdRaw) : null;

    // -------- 1) Active BUY entry from decision_journal --------------------
    // Pick the most recent BUY (decision_type='BUY') with framework_version v3.2 if any,
    // otherwise the latest BUY of any version. ADD is also accepted.
    const buyRows = await sbSelect(
      'decision_journal',
      `select=id,ticker,decision_type,decision_date,framework_version,decision_owner,reviewer,conviction_level,position_size_target_pct,position_size_band,investment_horizon,sector,industry,thesis_pillars,catalysts_v32,failure_modes,kill_criteria_v32,executive_summary,final_recommendation,position_sizing_rationale&ticker=eq.${encodeURIComponent(ticker)}&decision_type=in.(BUY,ADD)&active=eq.true&order=decision_date.desc&limit=5`
    );
    let memo = null;
    if (buyRows && buyRows.length > 0) {
      // Prefer v3.2; otherwise first
      memo = buyRows.find(r => (r.framework_version || '').toLowerCase().includes('v3.2')) || buyRows[0];
      // Normalize JSON fields
      memo.thesis_pillars = safeJson(memo.thesis_pillars);
      memo.catalysts_v32 = safeJson(memo.catalysts_v32);
      memo.failure_modes = safeJson(memo.failure_modes);
      memo.kill_criteria_v32 = safeJson(memo.kill_criteria_v32);
    }

    // -------- 2) Last completed reunderwriting_entries row -----------------
    // Used to compute what_changed deltas and carry over tracking baselines.
    const prevRows = await sbSelect(
      'reunderwriting_entries',
      `select=id,due_id,ticker,period_end,reviewed_at,framework_version,outcome_v32,conviction_level,position_size_actual_pct,cost_basis_per_share,unrealized_pnl_pct,days_held,thesis_tracking,premortem_tracking,kpi_dashboard,valuation_refresh,what_changed,next_actions,next_review_date,executive_summary,outcome_justification&ticker=eq.${encodeURIComponent(ticker)}&order=reviewed_at.desc&limit=2`
    );
    let previous = null;
    if (prevRows && prevRows.length > 0) {
      // If a due_id was provided, exclude the entry belonging to the same due (in case it's already partially filled)
      const candidate = dueId
        ? (prevRows.find(r => Number(r.due_id) !== Number(dueId)) || null)
        : prevRows[0];
      if (candidate) {
        candidate.thesis_tracking = safeJson(candidate.thesis_tracking);
        candidate.premortem_tracking = safeJson(candidate.premortem_tracking);
        candidate.kpi_dashboard = safeJson(candidate.kpi_dashboard);
        candidate.valuation_refresh = safeJson(candidate.valuation_refresh);
        candidate.what_changed = safeJson(candidate.what_changed);
        candidate.next_actions = safeJson(candidate.next_actions);
        previous = candidate;
      }
    }

    // -------- 3) Active premortem failure_modes ----------------------------
    // Canonical list of failure modes to evaluate (premortem_tracking baseline).
    let premortem = null;
    const pms = await sbSelect(
      'premortems',
      `select=id,thesis_summary,version,current_revision_id&ticker=eq.${encodeURIComponent(ticker)}&status=eq.active&limit=1`
    );
    if (pms && pms.length > 0) {
      const pm = pms[0];
      const fms = await sbSelect(
        'failure_modes',
        `select=id,failure_mode,category,severity_pct,probability_pct,status,trigger_type,trigger_config&premortem_id=eq.${pm.id}&order=id.asc`
      );
      premortem = {
        id: pm.id,
        thesis_summary: pm.thesis_summary,
        version: pm.version,
        failure_modes: fms || [],
      };
    }

    // -------- 4) Due metadata (if due_id provided) -------------------------
    let due = null;
    if (dueId) {
      const dues = await sbSelect(
        'reunderwriting_due',
        `select=id,ticker,period_end,doc_type,doc_url,status,due_date,created_at&id=eq.${dueId}&limit=1`
      );
      if (dues && dues.length > 0) due = dues[0];
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      ticker,
      memo,
      previous,
      premortem,
      due,
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
