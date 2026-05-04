// Auto-transition pipeline_cards stage based on trade/decision events.
//
// Lifecycle stages:
//   backlog -> analysis -> review -> decision -> approved -> {invested|passed|rejected}
//   invested -> closed (on SELL)
//
// Auto-transitions (idempotent, only fire when in eligible source state):
//   onBuyTrade(ticker)      : approved|decision|review -> invested
//   onSellDecision(ticker)  : invested -> closed
//   onPassDecision(ticker)  : decision|review|analysis|approved -> passed
//
// Reversibility (best-effort, callable from DELETE/PATCH handlers):
//   revertFromInvested(ticker)  : invested -> approved (only if no remaining BUY/ADD trades)
//   revertFromClosed(ticker)    : closed -> invested  (only if SELL no longer active)
//   revertFromPassed(ticker)    : passed -> decision  (only if PASS no longer active)
//
// All functions log warnings on failure but never throw — auto-transitions must
// not break the primary write path.

const { sbSelect, sbUpdate } = require('./_supabase');

const VALID_STAGES = ['backlog', 'analysis', 'review', 'decision', 'approved', 'rejected', 'invested', 'closed', 'passed'];

async function findCardByTicker(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  try {
    const rows = await sbSelect('pipeline_cards', `select=id,ticker,stage&ticker=eq.${encodeURIComponent(t)}&limit=1`);
    return rows && rows.length ? rows[0] : null;
  } catch (e) {
    console.warn('[pipeline-stage] findCardByTicker failed', t, e.message);
    return null;
  }
}

async function setStage(cardId, newStage, reason) {
  if (!VALID_STAGES.includes(newStage)) {
    console.warn('[pipeline-stage] invalid target stage', newStage);
    return { ok: false, error: 'invalid_stage' };
  }
  try {
    await sbUpdate('pipeline_cards', `id=eq.${cardId}`, { stage: newStage });
    console.log(`[pipeline-stage] card ${cardId} -> ${newStage} (${reason || 'auto'})`);
    return { ok: true, card_id: cardId, new_stage: newStage };
  } catch (e) {
    console.warn(`[pipeline-stage] setStage ${cardId}->${newStage} failed`, e.message);
    return { ok: false, error: e.message };
  }
}

// === Forward transitions ===

async function onBuyTrade(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card) return { ok: false, reason: 'no_card' };
  // Only transition if currently in a "considering / approved" state.
  // If already invested or closed (e.g. re-buying after exit), leave it.
  const eligible = ['approved', 'decision', 'review', 'analysis', 'backlog'];
  if (!eligible.includes(card.stage)) {
    return { ok: false, reason: 'stage_not_eligible', current: card.stage };
  }
  return setStage(card.id, 'invested', `auto: BUY/ADD trade for ${card.ticker}`);
}

async function onSellDecision(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card) return { ok: false, reason: 'no_card' };
  // Allow closing from invested or even from approved (edge case: manual SELL without trades).
  const eligible = ['invested', 'approved'];
  if (!eligible.includes(card.stage)) {
    return { ok: false, reason: 'stage_not_eligible', current: card.stage };
  }
  return setStage(card.id, 'closed', `auto: SELL decision for ${card.ticker}`);
}

async function onPassDecision(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card) return { ok: false, reason: 'no_card' };
  const eligible = ['decision', 'review', 'analysis', 'approved', 'backlog'];
  if (!eligible.includes(card.stage)) {
    return { ok: false, reason: 'stage_not_eligible', current: card.stage };
  }
  return setStage(card.id, 'passed', `auto: PASS decision for ${card.ticker}`);
}

// === Reversibility ===

async function revertFromInvested(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card || card.stage !== 'invested') return { ok: false, reason: 'not_invested' };
  // Only revert if no remaining BUY/ADD trades for this ticker
  try {
    const trades = await sbSelect('trades', `select=id&ticker=eq.${encodeURIComponent(card.ticker)}&trade_type=in.(BUY,ADD)&limit=1`);
    if (trades && trades.length > 0) {
      return { ok: false, reason: 'still_has_buy_trades' };
    }
  } catch (e) {
    console.warn('[pipeline-stage] revertFromInvested check failed', e.message);
    return { ok: false, error: e.message };
  }
  return setStage(card.id, 'approved', `auto: last BUY/ADD trade removed for ${card.ticker}`);
}

async function revertFromClosed(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card || card.stage !== 'closed') return { ok: false, reason: 'not_closed' };
  // Only revert if no active SELL decision remains
  try {
    const sells = await sbSelect('decision_journal', `select=id&ticker=eq.${encodeURIComponent(card.ticker)}&decision_type=eq.SELL&active=eq.true&limit=1`);
    if (sells && sells.length > 0) {
      return { ok: false, reason: 'still_has_active_sell' };
    }
  } catch (e) {
    console.warn('[pipeline-stage] revertFromClosed check failed', e.message);
    return { ok: false, error: e.message };
  }
  return setStage(card.id, 'invested', `auto: SELL decision removed for ${card.ticker}`);
}

async function revertFromPassed(ticker) {
  const card = await findCardByTicker(ticker);
  if (!card || card.stage !== 'passed') return { ok: false, reason: 'not_passed' };
  try {
    const passes = await sbSelect('decision_journal', `select=id&ticker=eq.${encodeURIComponent(card.ticker)}&decision_type=eq.PASS&active=eq.true&limit=1`);
    if (passes && passes.length > 0) {
      return { ok: false, reason: 'still_has_active_pass' };
    }
  } catch (e) {
    console.warn('[pipeline-stage] revertFromPassed check failed', e.message);
    return { ok: false, error: e.message };
  }
  return setStage(card.id, 'decision', `auto: PASS decision removed for ${card.ticker}`);
}

module.exports = {
  VALID_STAGES,
  onBuyTrade,
  onSellDecision,
  onPassDecision,
  revertFromInvested,
  revertFromClosed,
  revertFromPassed,
};
