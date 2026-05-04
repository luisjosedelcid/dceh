// GET /api/cockpit-summary
//   Single endpoint that powers /cockpit (CIO Layer #3 — Portfolio Cockpit).
//   Returns NAV/benchmark KPIs, positions enriched with MoS,
//   discipline gates evaluated, outstanding decisions list, and today's events.
//
// Auth: any authenticated user (read-only).

'use strict';

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');
const { loadAndCompute } = require('./_perf-load');

// ── Discipline gate thresholds (sourced from discipline_rules table) ──────
// Defaults used as fallback if DB read fails or row is missing.
const GATE_DEFAULTS = {
  RE_UNDERWRITING_DAYS: 5,
  POSITION_REVIEW_DAYS: 90,
  PM_TRIGGER_DAYS: 5,
  CASH_MIN_PCT: 0.10,
  CONCENTRATION_WARN_PCT: 0.35,
  CONCENTRATION_FAIL_PCT: 0.45,
};

const RULE_KEY_MAP = {
  re_underwriting_days: 'RE_UNDERWRITING_DAYS',
  position_review_days: 'POSITION_REVIEW_DAYS',
  pm_trigger_days: 'PM_TRIGGER_DAYS',
  cash_min_pct: 'CASH_MIN_PCT',
  concentration_warn_pct: 'CONCENTRATION_WARN_PCT',
  concentration_fail_pct: 'CONCENTRATION_FAIL_PCT',
};

async function loadDisciplineRules() {
  try {
    const rows = await sbSelect('discipline_rules', 'select=rule_key,value');
    const out = { ...GATE_DEFAULTS };
    for (const r of rows) {
      const target = RULE_KEY_MAP[r.rule_key];
      if (target) out[target] = Number(r.value);
    }
    return out;
  } catch (e) {
    console.error('cockpit-summary: failed to load discipline_rules, using defaults:', e.message);
    return { ...GATE_DEFAULTS };
  }
}

// Resolve current MoS anchor (RV or EPV) per ticker by reading the most recent
// premortem/note. For MVP we read latest reunderwriting_entry's kill_criteria_snapshot
// if it carries an `anchor_type` and `anchor_value`, otherwise return null.
async function getAnchorsByTicker(tickers) {
  if (!tickers.length) return {};
  const list = tickers.map(t => `"${t}"`).join(',');
  const rows = await sbSelect(
    'reunderwriting_entries',
    `select=ticker,reviewed_at,kill_criteria_snapshot&ticker=in.(${list})&order=reviewed_at.desc&limit=200`
  );
  const out = {};
  for (const r of rows) {
    if (out[r.ticker]) continue; // first row = most recent
    const snap = r.kill_criteria_snapshot || {};
    if (snap.anchor_type && snap.anchor_value) {
      out[r.ticker] = {
        anchor_type: String(snap.anchor_type).toUpperCase(),
        anchor_value: Number(snap.anchor_value),
        reviewed_at: r.reviewed_at,
      };
    }
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const daysAgo = (d) => Math.floor((today - new Date(d)) / 86400000);

    // Load discipline thresholds from DB (with hardcoded fallback)
    const GATES = await loadDisciplineRules();

    // ── 1) Performance: NAV, holdings, cash, vs IWQU.L ────────────────────
    const perf = await loadAndCompute({});
    const k = perf.kpis || null;
    const holdings = perf.holdings || [];
    const series = perf.dailySeries || [];

    // Day P&L: NAV today - NAV yesterday (using last 2 series points)
    let dayPnl = null, dayPnlPct = null;
    if (series.length >= 2) {
      const last = series[series.length - 1];
      const prev = series[series.length - 2];
      dayPnl = (last.nav || 0) - (prev.nav || 0);
      dayPnlPct = prev.nav ? dayPnl / prev.nav : null;
    }

    // YTD: TWR cumulative from Jan 1 of current year
    const yearStart = `${today.getFullYear()}-01-01`;
    const ytdAnchor = series.find(s => s.date >= yearStart) || series[0];
    const ytdPct = (k && ytdAnchor)
      ? ((1 + (k.twr_cum_pct || 0)) / (1 + (ytdAnchor.twr_cum || 0))) - 1
      : null;

    // IWQU.L YTD same way
    const iwquAnchor = ytdAnchor && ytdAnchor.iwqu_norm ? ytdAnchor.iwqu_norm : null;
    const iwquLast = series.length ? series[series.length - 1].iwqu_norm : null;
    const iwquYtd = (iwquAnchor && iwquLast) ? (iwquLast / iwquAnchor) - 1 : null;
    const vsIwquYtd = (ytdPct != null && iwquYtd != null) ? ytdPct - iwquYtd : null;

    // Cash %: holdings entries where ticker is SGOV or 91282CBT7 (T-bill) treated as cash
    const CASH_TICKERS = new Set(['SGOV', '91282CBT7']);
    const totalNav = k ? Number(k.nav || 0) : 0;
    const cashFromHoldings = holdings
      .filter(h => CASH_TICKERS.has(h.ticker))
      .reduce((s, h) => s + (Number(h.market_value) || 0), 0);
    const cashUsd = (k && k.cash_usd != null) ? Number(k.cash_usd) + cashFromHoldings : cashFromHoldings;
    const cashPct = totalNav > 0 ? cashUsd / totalNav : 0;

    // ── 2) Positions enrichment (anchor + last review + days_since_review) ─
    const equityHoldings = holdings.filter(h => !CASH_TICKERS.has(h.ticker));
    const tickers = equityHoldings.map(h => h.ticker);
    const [anchors, allEntries] = await Promise.all([
      getAnchorsByTicker(tickers),
      tickers.length
        ? sbSelect('reunderwriting_entries',
            `select=ticker,reviewed_at&ticker=in.(${tickers.map(t=>`"${t}"`).join(',')})&order=reviewed_at.desc&limit=500`)
        : Promise.resolve([]),
    ]);
    const lastReviewByTicker = {};
    for (const r of allEntries) {
      if (!lastReviewByTicker[r.ticker]) lastReviewByTicker[r.ticker] = r.reviewed_at;
    }

    const positions = equityHoldings.map(h => {
      const anchor = anchors[h.ticker] || null;
      const px = h.last_price;
      let mosPct = null;
      if (anchor && px && anchor.anchor_value > 0) {
        mosPct = (anchor.anchor_value - px) / anchor.anchor_value;
      }
      const lastReview = lastReviewByTicker[h.ticker] || null;
      const daysSinceReview = lastReview ? daysAgo(lastReview) : null;
      return {
        ticker: h.ticker,
        qty: h.qty,
        last_price: px,
        market_value: h.market_value,
        weight_pct: h.weight_pct,
        unrealized_pnl: h.unrealized_pnl,
        unrealized_pct: (h.cost_basis && h.market_value) ? (h.market_value / h.cost_basis) - 1 : null,
        anchor_type: anchor ? anchor.anchor_type : null,
        anchor_value: anchor ? anchor.anchor_value : null,
        mos_pct: mosPct,
        last_review_date: lastReview,
        days_since_review: daysSinceReview,
      };
    });

    // ── 3) Pull all data for gates + decisions in parallel ─────────────────
    const [duesPending, watchlistAll, premortems, docsRecent] = await Promise.all([
      sbSelect('reunderwriting_due',
        'select=id,ticker,period_end,doc_type,due_at,status,source_documents(filed_at,source_url)&status=eq.pending&order=due_at.asc&limit=100'),
      sbSelect('watchlist',
        'select=id,ticker,target_price,anchor_type,anchor_value_per_share,mos_required_pct,catalyst,deadline_review,status,triggered_at,triggered_price,triggered_mos_pct,updated_at&status=in.(active,triggered)&order=updated_at.desc&limit=100'),
      sbSelect('premortems',
        'select=id,ticker,status&status=eq.active&limit=100'),
      sbSelect('source_documents',
        `select=ticker,doc_type,filed_at,source_url&order=filed_at.desc&limit=10`),
    ]);

    // failure_modes for active premortems (for gate #3 + decisions)
    let failureModes = [];
    if (premortems.length) {
      const pmIds = premortems.map(p => p.id).join(',');
      failureModes = await sbSelect('failure_modes',
        `select=id,premortem_id,failure_mode,status,triggered_at&premortem_id=in.(${pmIds})&limit=500`);
    }
    const pmTickerById = new Map(premortems.map(p => [p.id, p.ticker]));
    const triggeredFms = failureModes
      .filter(fm => fm.status === 'triggered' && fm.triggered_at)
      .map(fm => ({ ...fm, ticker: pmTickerById.get(fm.premortem_id), days_open: daysAgo(fm.triggered_at) }));

    // Watchlist current prices (for gap calc)
    const watchTickers = Array.from(new Set(watchlistAll.map(w => w.ticker)));
    let watchPrices = {};
    if (watchTickers.length) {
      const list = watchTickers.map(t => `"${t}"`).join(',');
      const rows = await sbSelect('prices_daily',
        `select=ticker,close_native,price_date&ticker=in.(${list})&order=price_date.desc&limit=${watchTickers.length * 5}`);
      for (const r of rows) if (!watchPrices[r.ticker]) watchPrices[r.ticker] = Number(r.close_native);
    }

    // ── 4) Discipline gates ────────────────────────────────────────────────
    const gates = [];

    // Gate 1: Re-underwriting ≤5d after 10-Q filing
    const overdueDues = duesPending.filter(d => {
      const filed = d.source_documents?.filed_at;
      if (!filed) return false;
      return daysAgo(filed) > GATES.RE_UNDERWRITING_DAYS;
    });
    gates.push({
      id: 'reunderwriting_5d',
      label: `Re-underwriting completado en ≤${GATES.RE_UNDERWRITING_DAYS} días tras 10-Q/10-K`,
      status: overdueDues.length === 0 ? 'OK' : 'FAIL',
      detail: overdueDues.length === 0
        ? (duesPending.length === 0 ? 'Sin filings pendientes' : `${duesPending.length} due(s) abierto(s) dentro de ventana`)
        : `${overdueDues.length} due(s) vencido(s): ${overdueDues.map(d => `${d.ticker} (${daysAgo(d.source_documents.filed_at)}d)`).join(', ')}`,
    });

    // Gate 2: Every position reviewed within 90 days
    const stalePositions = positions.filter(p => p.days_since_review == null || p.days_since_review > GATES.POSITION_REVIEW_DAYS);
    gates.push({
      id: 'position_review_90d',
      label: `Todas las posiciones revisadas en ≤${GATES.POSITION_REVIEW_DAYS} días`,
      status: positions.length === 0 ? 'OK' : (stalePositions.length === 0 ? 'OK' : 'FAIL'),
      detail: positions.length === 0
        ? 'Sin posiciones'
        : (stalePositions.length === 0
          ? `${positions.length} posición(es), revisión más antigua: ${Math.max(...positions.map(p => p.days_since_review || 0))}d`
          : `${stalePositions.length} stale: ${stalePositions.map(p => `${p.ticker} (${p.days_since_review == null ? 'sin revisión' : p.days_since_review + 'd'})`).join(', ')}`),
    });

    // Gate 3: Pre-mortem trigger >5d unaddressed
    const oldFms = triggeredFms.filter(fm => fm.days_open > GATES.PM_TRIGGER_DAYS);
    gates.push({
      id: 'premortem_trigger_5d',
      label: `Sin pre-mortem trigger >${GATES.PM_TRIGGER_DAYS} días sin atender`,
      status: oldFms.length === 0 ? 'OK' : 'FAIL',
      detail: triggeredFms.length === 0
        ? '0 triggers activos'
        : (oldFms.length === 0
          ? `${triggeredFms.length} trigger(s) activos, todos dentro de ventana`
          : `${oldFms.length} trigger(s) >5d: ${oldFms.map(f => `${f.ticker} (${f.days_open}d)`).join(', ')}`),
    });

    // Gate 4: Cash ≥ 10%
    gates.push({
      id: 'cash_min',
      label: `Cash ≥ ${(GATES.CASH_MIN_PCT * 100).toFixed(0)}% (preservación de capital)`,
      status: cashPct >= GATES.CASH_MIN_PCT ? 'OK' : 'FAIL',
      detail: `${(cashPct * 100).toFixed(1)}% actual${cashPct >= GATES.CASH_MIN_PCT ? '' : ` (déficit ${((GATES.CASH_MIN_PCT - cashPct) * 100).toFixed(1)} pts)`}`,
    });

    // Gate 5: Concentration ≤ 35% (WARN), > 45% (FAIL)
    const maxWeight = positions.length ? Math.max(...positions.map(p => p.weight_pct || 0)) : 0;
    const maxTicker = positions.find(p => p.weight_pct === maxWeight);
    let concStatus = 'OK';
    if (maxWeight > GATES.CONCENTRATION_FAIL_PCT) concStatus = 'FAIL';
    else if (maxWeight > GATES.CONCENTRATION_WARN_PCT) concStatus = 'WARN';
    gates.push({
      id: 'concentration_max',
      label: `Diversificación: ninguna posición >${(GATES.CONCENTRATION_WARN_PCT * 100).toFixed(0)}%`,
      status: concStatus,
      detail: positions.length === 0
        ? 'Sin posiciones'
        : `Max: ${maxTicker ? maxTicker.ticker : '—'} ${(maxWeight * 100).toFixed(1)}%`,
    });

    // ── 5) Outstanding Decisions (priorized) ──────────────────────────────
    const decisions = [];

    // 5a) Re-underwriting overdue (highest priority)
    for (const d of overdueDues) {
      const filed = d.source_documents?.filed_at;
      decisions.push({
        priority: 1,
        ticker: d.ticker,
        title: `Re-underwriting ${d.doc_type || '10-Q'}`,
        detail: `Filing ${d.period_end} · ingestado hace ${daysAgo(filed)} días`,
        deadline_label: `Vencida hace ${daysAgo(filed) - GATES.RE_UNDERWRITING_DAYS} días`,
        deadline_urgent: true,
        gate: 'reunderwriting_5d',
        cta_url: '/journal#re-underwriting',
      });
    }

    // 5b) Stale position reviews (positions >90d)
    for (const p of stalePositions) {
      decisions.push({
        priority: 2,
        ticker: p.ticker,
        title: 'Revisión 90-day pendiente',
        detail: p.last_review_date
          ? `Última revisión: ${p.last_review_date} (${p.days_since_review}d)`
          : 'Sin entry de re-underwriting registrado',
        deadline_label: p.days_since_review
          ? `Vencida hace ${p.days_since_review - GATES.POSITION_REVIEW_DAYS}d`
          : 'Sin revisión',
        deadline_urgent: true,
        gate: 'position_review_90d',
        cta_url: '/journal#re-underwriting',
      });
    }

    // 5c) Old failure modes
    for (const fm of oldFms) {
      decisions.push({
        priority: 3,
        ticker: fm.ticker,
        title: 'Pre-mortem trigger sin atender',
        detail: `${fm.failure_mode} · activado hace ${fm.days_open} días`,
        deadline_label: `${fm.days_open}d abierto`,
        deadline_urgent: true,
        gate: 'premortem_trigger_5d',
        cta_url: '/pre-mortem',
      });
    }

    // 5d) Concentration
    if (concStatus !== 'OK' && maxTicker) {
      decisions.push({
        priority: concStatus === 'FAIL' ? 1 : 4,
        ticker: maxTicker.ticker,
        title: concStatus === 'FAIL' ? 'Concentración crítica — trim obligatorio' : 'Concentración elevada — evaluar trim',
        detail: `Peso ${(maxWeight * 100).toFixed(1)}% (umbral ${(GATES.CONCENTRATION_WARN_PCT * 100).toFixed(0)}%)`,
        deadline_label: concStatus === 'FAIL' ? 'Acción requerida' : 'Atención',
        deadline_urgent: concStatus === 'FAIL',
        gate: 'concentration_max',
        cta_url: '/performance',
      });
    }

    // 5e) Cash deficit
    if (cashPct < GATES.CASH_MIN_PCT) {
      decisions.push({
        priority: 2,
        ticker: '—',
        title: 'Cash por debajo del mínimo',
        detail: `${(cashPct * 100).toFixed(1)}% vs umbral ${(GATES.CASH_MIN_PCT * 100).toFixed(0)}%`,
        deadline_label: 'Acción requerida',
        deadline_urgent: true,
        gate: 'cash_min',
        cta_url: '/performance',
      });
    }

    // 5f) Watchlist triggered (acción: comprar o archivar)
    const triggeredWatch = watchlistAll.filter(w => w.status === 'triggered');
    for (const w of triggeredWatch) {
      decisions.push({
        priority: 1,
        ticker: w.ticker,
        title: 'Watchlist disparada — decidir compra',
        detail: `Trigger a $${w.triggered_price} · MoS ${(Number(w.triggered_mos_pct) * 100).toFixed(1)}% · ancla ${w.anchor_type} $${w.anchor_value_per_share}`,
        deadline_label: w.triggered_at ? `Hace ${daysAgo(w.triggered_at)}d` : 'Disparada',
        deadline_urgent: true,
        gate: null,
        cta_url: '/universe#watchlist',
      });
    }

    // 5g) Active watchlist (just informational, low priority)
    const activeWatch = watchlistAll.filter(w => w.status === 'active');
    for (const w of activeWatch) {
      const px = watchPrices[w.ticker];
      const gapPct = (px != null && w.target_price)
        ? (px - Number(w.target_price)) / Number(w.target_price) : null;
      decisions.push({
        priority: 5,
        ticker: w.ticker,
        title: 'Watchlist activa',
        detail: px != null
          ? `Target $${w.target_price} · actual $${px} · gap ${gapPct != null ? (gapPct * 100).toFixed(1) + '%' : '—'}`
          : `Target $${w.target_price} · sin precio reciente`,
        deadline_label: w.deadline_review ? `Review ${w.deadline_review}` : 'Esperar',
        deadline_urgent: false,
        gate: null,
        cta_url: '/universe#watchlist',
      });
    }

    decisions.sort((a, b) => a.priority - b.priority);

    // ── 6) Today's events (recent ingests + last cron runs) ───────────────
    const events = [];
    // Last 4 source_documents
    for (const d of (docsRecent || []).slice(0, 4)) {
      events.push({
        type: 'doc',
        label: `${d.doc_type || 'doc'} ingestado`,
        detail: `${d.ticker} · filed ${d.filed_at}`,
        when: d.filed_at,
      });
    }
    // Last triggered watchlist
    if (triggeredWatch.length) {
      const last = triggeredWatch[0];
      events.push({
        type: 'watchlist',
        label: 'Watchlist disparada',
        detail: `${last.ticker} a $${last.triggered_price}`,
        when: last.triggered_at,
      });
    }
    events.sort((a, b) => (b.when || '').localeCompare(a.when || ''));

    // ── 7) Build summary ──────────────────────────────────────────────────
    const okGates = gates.filter(g => g.status === 'OK').length;
    const failGates = gates.filter(g => g.status === 'FAIL').length;
    const warnGates = gates.filter(g => g.status === 'WARN').length;

    const alerts = {
      reviews_overdue: overdueDues.length + stalePositions.length,
      watch_triggered: triggeredWatch.length,
      pm_triggered: triggeredFms.length,
      concentration_warn: concStatus !== 'OK' ? 1 : 0,
      cash_low: cashPct < GATES.CASH_MIN_PCT ? 1 : 0,
    };

    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.status(200).end(JSON.stringify({
      ok: true,
      generated_at: new Date().toISOString(),
      kpis: {
        nav_usd: k ? k.nav : 0,
        day_pnl_usd: dayPnl,
        day_pnl_pct: dayPnlPct,
        ytd_pct: ytdPct,
        iwqu_ytd_pct: iwquYtd,
        vs_iwqu_ytd_pct: vsIwquYtd,
        positions_count: positions.length,
        cash_usd: cashUsd,
        cash_pct: cashPct,
      },
      alerts,
      gates,
      gates_summary: { ok: okGates, fail: failGates, warn: warnGates, total: gates.length },
      positions,
      decisions,
      events,
      thresholds: GATES,
    }));
  } catch (e) {
    console.error('cockpit-summary error:', e);
    res.setHeader('content-type', 'application/json');
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
