// Pre-mortem trigger evaluation engine.
//
// Capa 1 supports `quantitative` triggers only:
//   - price_below          : { check:'price_below', threshold:NUM, reference?:STR }
//   - price_above          : { check:'price_above', threshold:NUM, reference?:STR }
//   - drawdown_from_max    : { check:'drawdown_from_max', threshold_pct:NUM, window_days?:NUM (default 252) }
//   - drawdown_from_entry  : { check:'drawdown_from_entry', threshold_pct:NUM }
//   - weight_above         : { check:'weight_above', threshold_pct:NUM }
//   - time_held_above      : { check:'time_held_above', threshold_days:NUM }
//
// `qualitative_manual` triggers are skipped (status flips manually via UI).
// `qualitative_llm` triggers are deferred to Capa 4.

'use strict';

const { sbSelect, sbInsert, sbUpdate } = require('./_supabase');
const { loadAndCompute } = require('./_perf-load');
const { evaluateLlmTrigger } = require('./_premortem-llm');

// Cached holdings/prices per request to avoid redundant queries.
async function buildContext() {
  const perf = await loadAndCompute({}); // gives kpis + holdings + dailySeries
  const today = new Date().toISOString().slice(0, 10);

  // Build per-ticker lookup
  const holdingsByTicker = new Map();
  for (const h of (perf.holdings || [])) holdingsByTicker.set(h.ticker, h);

  // Pull prices_daily for max-window calculations (last 252 trading days = ~365 cal days)
  const prices = await sbSelect(
    'prices_daily',
    'select=ticker,price_date,close_native&order=price_date.asc&limit=100000'
  );
  const pricesByTicker = new Map();
  for (const p of prices) {
    if (!pricesByTicker.has(p.ticker)) pricesByTicker.set(p.ticker, []);
    pricesByTicker.get(p.ticker).push({ date: p.price_date, close: Number(p.close_native) });
  }

  // Pull transactions for entry price / time held
  const tx = await sbSelect(
    'transactions',
    'select=trade_date,ticker,side,qty,price_native&order=trade_date.asc&limit=10000'
  );
  const firstBuyByTicker = new Map(); // earliest BUY per ticker
  const avgEntryByTicker = new Map();
  const grouped = new Map();
  for (const t of tx) {
    if (!grouped.has(t.ticker)) grouped.set(t.ticker, []);
    grouped.get(t.ticker).push(t);
    if (t.side === 'BUY' && !firstBuyByTicker.has(t.ticker)) firstBuyByTicker.set(t.ticker, t.trade_date);
  }
  // weighted avg entry price (BUY-only, for entry-relative DD)
  for (const [tk, arr] of grouped) {
    let qty = 0, cost = 0;
    for (const t of arr) {
      if (t.side === 'BUY') { qty += Number(t.qty); cost += Number(t.qty) * Number(t.price_native); }
    }
    if (qty > 0) avgEntryByTicker.set(tk, cost / qty);
  }

  return {
    today,
    perf,
    holdingsByTicker,
    pricesByTicker,
    firstBuyByTicker,
    avgEntryByTicker,
  };
}

function lastClose(ctx, ticker) {
  const arr = ctx.pricesByTicker.get(ticker);
  if (!arr || !arr.length) return null;
  return arr[arr.length - 1].close;
}

function maxCloseInWindow(ctx, ticker, windowDays) {
  const arr = ctx.pricesByTicker.get(ticker);
  if (!arr || !arr.length) return null;
  if (!windowDays || windowDays >= arr.length) {
    return Math.max(...arr.map(p => p.close));
  }
  return Math.max(...arr.slice(-windowDays).map(p => p.close));
}

// ── Per-trigger evaluators ───────────────────────────────────────────────────
function evalPriceBelow(ctx, ticker, cfg) {
  const px = lastClose(ctx, ticker);
  if (px == null) return { status: 'error', evidence: 'No price data available.' };
  const triggered = px < Number(cfg.threshold);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: px,
    threshold_value: Number(cfg.threshold),
    evidence: `${ticker} closed at $${px.toFixed(2)} ${triggered ? '<' : '\u2265'} threshold $${Number(cfg.threshold).toFixed(2)}${cfg.reference ? ` (${cfg.reference})` : ''}.`,
  };
}

function evalPriceAbove(ctx, ticker, cfg) {
  const px = lastClose(ctx, ticker);
  if (px == null) return { status: 'error', evidence: 'No price data available.' };
  const triggered = px > Number(cfg.threshold);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: px,
    threshold_value: Number(cfg.threshold),
    evidence: `${ticker} closed at $${px.toFixed(2)} ${triggered ? '>' : '\u2264'} threshold $${Number(cfg.threshold).toFixed(2)}.`,
  };
}

function evalDrawdownFromMax(ctx, ticker, cfg) {
  const px = lastClose(ctx, ticker);
  const peak = maxCloseInWindow(ctx, ticker, Number(cfg.window_days || 252));
  if (px == null || peak == null) return { status: 'error', evidence: 'No price data available.' };
  const ddPct = ((peak - px) / peak) * 100;
  const triggered = ddPct >= Number(cfg.threshold_pct);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: ddPct,
    threshold_value: Number(cfg.threshold_pct),
    evidence: `${ticker} drawdown ${ddPct.toFixed(2)}% from ${(cfg.window_days || 252)}d high ($${peak.toFixed(2)} \u2192 $${px.toFixed(2)}); threshold ${cfg.threshold_pct}%.`,
  };
}

function evalDrawdownFromEntry(ctx, ticker, cfg) {
  const px = lastClose(ctx, ticker);
  const entry = ctx.avgEntryByTicker.get(ticker);
  if (px == null || entry == null) return { status: 'error', evidence: 'No price/entry available.' };
  const ddPct = ((entry - px) / entry) * 100;
  const triggered = ddPct >= Number(cfg.threshold_pct);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: ddPct,
    threshold_value: Number(cfg.threshold_pct),
    evidence: `${ticker} ${ddPct >= 0 ? 'down' : 'up'} ${Math.abs(ddPct).toFixed(2)}% vs avg entry $${entry.toFixed(2)} (current $${px.toFixed(2)}); threshold ${cfg.threshold_pct}% drawdown.`,
  };
}

function evalWeightAbove(ctx, ticker, cfg) {
  const h = ctx.holdingsByTicker.get(ticker);
  if (!h || h.weight_pct == null) return { status: 'error', evidence: 'Position not found.' };
  const wPct = Number(h.weight_pct) * 100;
  const triggered = wPct > Number(cfg.threshold_pct);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: wPct,
    threshold_value: Number(cfg.threshold_pct),
    evidence: `${ticker} represents ${wPct.toFixed(2)}% of portfolio MV ${triggered ? '>' : '\u2264'} ${cfg.threshold_pct}% threshold.`,
  };
}

function evalTimeHeldAbove(ctx, ticker, cfg) {
  const firstBuy = ctx.firstBuyByTicker.get(ticker);
  if (!firstBuy) return { status: 'error', evidence: 'No BUY transaction found.' };
  const days = Math.floor((Date.parse(ctx.today) - Date.parse(firstBuy)) / 86400000);
  const triggered = days > Number(cfg.threshold_days);
  return {
    status: triggered ? 'triggered' : 'monitoring',
    observed_value: days,
    threshold_value: Number(cfg.threshold_days),
    evidence: `${ticker} held for ${days} days (since ${firstBuy}); review threshold ${cfg.threshold_days} days.`,
  };
}

const QUANT_DISPATCH = {
  price_below: evalPriceBelow,
  price_above: evalPriceAbove,
  drawdown_from_max: evalDrawdownFromMax,
  drawdown_from_entry: evalDrawdownFromEntry,
  weight_above: evalWeightAbove,
  time_held_above: evalTimeHeldAbove,
};

// ── Top-level eval ───────────────────────────────────────────────────────────
async function evaluateOne(fm, ctx, ticker) {
  const tt = fm.trigger_type;

  if (tt === 'qualitative_manual' || tt === 'quarterly_metric') {
    // qualitative_manual: updated via UI
    // quarterly_metric: updated only by reunderwriting-submit (committee captures observed value when a 10-K/10-Q is signed)
    return null;
  }
  if (tt === 'qualitative_llm') {
    try {
      return await evaluateLlmTrigger(fm, ticker);
    } catch (e) {
      return { status: 'error', evidence: `LLM eval threw: ${String(e.message || e).slice(0,200)}` };
    }
  }
  if (tt !== 'quantitative') {
    return { status: 'error', evidence: `Unknown trigger_type: ${tt}` };
  }

  const cfg = fm.trigger_config || {};
  const fn = QUANT_DISPATCH[cfg.check];
  if (!fn) return { status: 'error', evidence: `Unknown quantitative check: ${cfg.check}` };

  try {
    return fn(ctx, ticker, cfg);
  } catch (e) {
    return { status: 'error', evidence: `Eval threw: ${e.message}` };
  }
}

// Evaluate all failure modes for a ticker (or all tickers if ticker=null)
async function evaluateAll({ ticker = null, dryRun = false } = {}) {
  const ctx = await buildContext();

  // Pull active premortems + their failure modes
  let pmQuery = 'select=id,ticker,status&status=eq.active';
  if (ticker) pmQuery += `&ticker=eq.${encodeURIComponent(ticker)}`;
  const pms = await sbSelect('premortems', pmQuery);

  if (pms.length === 0) return { evaluated: 0, transitions: [], details: [] };

  const pmIds = pms.map(p => p.id).join(',');
  const fms = await sbSelect(
    'failure_modes',
    `select=id,premortem_id,failure_mode,category,trigger_type,trigger_config,status,probability_pct,severity_pct&premortem_id=in.(${pmIds})`
  );

  const pmById = new Map(pms.map(p => [p.id, p]));

  const details = [];
  const transitions = []; // newly triggered
  let evaluated = 0;

  for (const fm of fms) {
    const pm = pmById.get(fm.premortem_id);
    if (!pm) continue;
    const result = await evaluateOne(fm, ctx, pm.ticker);
    if (result === null) continue; // skipped
    evaluated++;

    const newStatus = result.status;
    const wasTriggered = fm.status === 'triggered';
    const becomesTriggered = newStatus === 'triggered';
    const transitionedToTriggered = !wasTriggered && becomesTriggered;

    details.push({
      failure_mode_id: fm.id,
      ticker: pm.ticker,
      failure_mode: fm.failure_mode,
      category: fm.category,
      check: (fm.trigger_config && fm.trigger_config.check) || null,
      prior_status: fm.status,
      new_status: newStatus,
      observed_value: result.observed_value ?? null,
      threshold_value: result.threshold_value ?? null,
      evidence: result.evidence,
      transitioned: transitionedToTriggered,
      probability_pct: fm.probability_pct,
      severity_pct: fm.severity_pct,
    });

    if (transitionedToTriggered) {
      transitions.push({
        ticker: pm.ticker,
        failure_mode: fm.failure_mode,
        category: fm.category,
        evidence: result.evidence,
        probability_pct: fm.probability_pct,
        severity_pct: fm.severity_pct,
      });
    }

    if (!dryRun) {
      // Insert evaluation row (now also persists llm_response + source_doc_id)
      const evalRow = {
        failure_mode_id: fm.id,
        evaluated_at: new Date().toISOString(),
        status: newStatus,
        observed_value: result.observed_value ?? null,
        threshold_value: result.threshold_value ?? null,
        evidence_text: result.evidence,
      };
      if (result.llm_response) evalRow.llm_response = result.llm_response;
      if (result.source_doc_ids && result.source_doc_ids.length > 0) {
        evalRow.source_doc_id = result.source_doc_ids[0]; // primary doc
      }
      await sbInsert('trigger_evaluations', evalRow);
      // Update failure_mode if status changed (or last_evaluated_at always)
      const patch = { last_evaluated_at: new Date().toISOString() };
      if (newStatus !== fm.status && newStatus !== 'error') {
        patch.status = newStatus;
        if (becomesTriggered && !fm.triggered_at) patch.triggered_at = new Date().toISOString();
      }
      await sbUpdate('failure_modes', `id=eq.${fm.id}`, patch);
    }
  }

  return { evaluated, transitions, details };
}

module.exports = { evaluateAll, evaluateOne, buildContext };
