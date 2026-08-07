// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Discipline Rules evaluator (pure, reusable)
// ───────────────────────────────────────────────────────────────────
// Reads current state + the 6 discipline_rules and returns violations.
//
// Exports:
//   evaluateDiscipline() -> {
//     evaluated_at: ISO,
//     rules: {...},                       // rule_key -> {value, unit, label}
//     violations: [                       // empty if all healthy
//       { rule_key, level:'WARN'|'FAIL', message, detail }
//     ],
//     summary: { total_rules, violations, warns, fails }
//   }
//
// This is a *pure* read; no side effects. Callable from cron, dashboards,
// or ad-hoc admin endpoints.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { sbSelect } = require('./_supabase');

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / 86400000);
}

async function evaluateDiscipline() {
  const evaluatedAt = new Date().toISOString();
  const violations = [];

  // ── Load rules keyed by rule_key ──
  const ruleRows = await sbSelect('discipline_rules', 'select=*&order=rule_key.asc');
  const rules = {};
  for (const r of ruleRows) rules[r.rule_key] = r;

  const val = k => (rules[k] ? Number(rules[k].value) : null);

  // ── 1. Latest portfolio snapshot for cash / concentration ──
  const snapRows = await sbSelect(
    'portfolio_snapshots',
    'select=snapshot_date,nav_usd,cash_usd,holdings_json&order=snapshot_date.desc&limit=1'
  );
  const snap = snapRows && snapRows[0];

  if (snap && snap.nav_usd && Number(snap.nav_usd) > 0) {
    const nav = Number(snap.nav_usd);
    const cash = Number(snap.cash_usd || 0);
    const cashPct = cash / nav;
    const cashMin = val('cash_min_pct');
    if (cashMin != null && cashPct < cashMin) {
      violations.push({
        rule_key: 'cash_min_pct',
        level: 'WARN',
        message: `Cash ${(cashPct * 100).toFixed(1)}% < mínimo ${(cashMin * 100).toFixed(0)}%`,
        detail: { cash_usd: cash, nav_usd: nav, cash_pct: cashPct, min_pct: cashMin, snapshot_date: snap.snapshot_date },
      });
    }

    // Concentration — max weight from holdings_json
    let holdings = snap.holdings_json;
    if (typeof holdings === 'string') { try { holdings = JSON.parse(holdings); } catch (_) { holdings = null; } }
    if (Array.isArray(holdings) && holdings.length > 0) {
      let maxPos = null;
      for (const h of holdings) {
        const w = Number(h.weight_pct != null ? h.weight_pct : (Number(h.market_value_usd || 0) / nav));
        if (!Number.isFinite(w)) continue;
        if (!maxPos || w > maxPos.w) maxPos = { ticker: h.ticker || h.symbol || '?', w };
      }
      if (maxPos) {
        const failLim = val('concentration_fail_pct');
        const warnLim = val('concentration_warn_pct');
        if (failLim != null && maxPos.w > failLim) {
          violations.push({
            rule_key: 'concentration_fail_pct',
            level: 'FAIL',
            message: `${maxPos.ticker} pesa ${(maxPos.w * 100).toFixed(1)}% > FAIL ${(failLim * 100).toFixed(0)}%`,
            detail: { ticker: maxPos.ticker, weight_pct: maxPos.w, fail_limit: failLim, snapshot_date: snap.snapshot_date },
          });
        } else if (warnLim != null && maxPos.w > warnLim) {
          violations.push({
            rule_key: 'concentration_warn_pct',
            level: 'WARN',
            message: `${maxPos.ticker} pesa ${(maxPos.w * 100).toFixed(1)}% > WARN ${(warnLim * 100).toFixed(0)}%`,
            detail: { ticker: maxPos.ticker, weight_pct: maxPos.w, warn_limit: warnLim, snapshot_date: snap.snapshot_date },
          });
        }
      }
    }
  }

  // ── 2. Pre-mortem triggered demasiado tiempo abierto ──
  const pmTriggerDays = val('pm_trigger_days');
  if (pmTriggerDays != null) {
    // premortems has no `triggered_at`; use updated_at when status changed to triggered.
    // Conservative: any status='triggered' whose updated_at is older than N days.
    const pmRows = await sbSelect(
      'premortems',
      'select=id,ticker,status,updated_at&status=eq.triggered&order=updated_at.asc'
    );
    for (const pm of pmRows || []) {
      const days = daysBetween(pm.updated_at, evaluatedAt);
      if (days > pmTriggerDays) {
        violations.push({
          rule_key: 'pm_trigger_days',
          level: 'WARN',
          message: `Pre-mortem ${pm.ticker} triggered hace ${days}d (> ${pmTriggerDays}d)`,
          detail: { ticker: pm.ticker, premortem_id: pm.id, days_open: days, limit: pmTriggerDays },
        });
      }
    }
  }

  // ── 3. Re-underwriting pendiente > N días ──
  const ruDays = val('re_underwriting_days');
  if (ruDays != null) {
    const dueRows = await sbSelect(
      'reunderwriting_due',
      'select=id,ticker,doc_type,period_end,due_at,status&status=eq.pending&order=due_at.asc'
    );
    for (const d of dueRows || []) {
      const days = daysBetween(d.due_at, evaluatedAt);
      if (days > ruDays) {
        violations.push({
          rule_key: 're_underwriting_days',
          level: 'WARN',
          message: `Re-underwriting ${d.ticker} ${d.doc_type || ''} ${days}d atrasado (> ${ruDays}d)`,
          detail: { ticker: d.ticker, doc_type: d.doc_type, period_end: d.period_end, due_at: d.due_at, days_overdue: days, limit: ruDays },
        });
      }
    }
  }

  // ── 4. position_review_days: ticker con re-underwriting_entries más viejo que N días ──
  // Only for tickers actually invested (from latest snapshot holdings_json).
  const reviewDays = val('position_review_days');
  if (reviewDays != null && snap) {
    let holdings = snap.holdings_json;
    if (typeof holdings === 'string') { try { holdings = JSON.parse(holdings); } catch (_) { holdings = null; } }
    const tickers = Array.isArray(holdings) ? holdings.map(h => (h.ticker || h.symbol || '').toUpperCase()).filter(Boolean) : [];
    for (const t of tickers) {
      const rows = await sbSelect(
        'reunderwriting_entries',
        `select=id,ticker,created_at&ticker=eq.${encodeURIComponent(t)}&order=created_at.desc&limit=1`
      );
      const last = rows && rows[0];
      if (!last) {
        violations.push({
          rule_key: 'position_review_days',
          level: 'WARN',
          message: `${t} no tiene re-underwriting registrado`,
          detail: { ticker: t, days_since_review: null, limit: reviewDays },
        });
        continue;
      }
      const days = daysBetween(last.created_at, evaluatedAt);
      if (days > reviewDays) {
        violations.push({
          rule_key: 'position_review_days',
          level: 'WARN',
          message: `${t} sin re-underwriting hace ${days}d (> ${reviewDays}d)`,
          detail: { ticker: t, days_since_review: days, limit: reviewDays },
        });
      }
    }
  }

  const summary = {
    total_rules: ruleRows.length,
    violations: violations.length,
    warns: violations.filter(v => v.level === 'WARN').length,
    fails: violations.filter(v => v.level === 'FAIL').length,
  };

  return { evaluated_at: evaluatedAt, rules, violations, summary };
}

module.exports = { evaluateDiscipline };
