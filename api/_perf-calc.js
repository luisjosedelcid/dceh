// DCE Performance — pure computation engine
//
// Inputs (all USD-denominated; FX is folded in by callers via *_usd helpers below):
//   transactions: [{ trade_date:'YYYY-MM-DD', ticker, side:'BUY'|'SELL', qty, price_native, fee_native, fx_to_usd }]
//   cashflows:    [{ occurred_at:'YYYY-MM-DD', ticker?, cf_type:'CONTRIBUTION'|'WITHDRAWAL'|'DIVIDEND'|'INTEREST'|'FEE'|'TAX', amount_native, fx_to_usd }]
//   prices:       [{ price_date:'YYYY-MM-DD', ticker, close_native }]   (currency assumed USD here)
//   iwquSeries:   [{ price_date, close_native }]                         (IWQU.L benchmark)
//   startDate:    'YYYY-MM-DD' (typically MIN(trade_date, occurred_at))
//   endDate:      'YYYY-MM-DD' (typically today)
//
// Outputs:
//   {
//     dailySeries: [{ date, nav, cash, invested_basis, twr_daily, twr_cum, drawdown, iwqu_norm }],
//     holdings:    [{ ticker, qty, avg_cost, last_price, market_value, unrealized_pnl, weight_pct }],
//     kpis: {
//       nav, cash_usd, market_value_usd, invested_usd, total_contributions, total_withdrawals,
//       realized_pnl, unrealized_pnl, total_pnl_usd, total_return_pct,
//       twr_cum_pct, irr_pct, max_drawdown_pct, iwqu_return_pct,
//       inception_date, last_date, days_elapsed
//     }
//   }
//
// Conventions:
// - All money values are in USD throughout the engine.
// - tx_usd_amount = qty * price_native * fx + (sign * fee). Buys reduce cash; sells add cash.
// - Cashflows: CONTRIBUTION/DIVIDEND/INTEREST add cash. WITHDRAWAL/FEE/TAX reduce cash.
// - External flows (for TWR) = CONTRIBUTION - WITHDRAWAL only. Dividends/interest are INTERNAL.
// - Modified Dietz daily approximation: assume external flows happen at start of day.
//   r_t = (NAV_t - NAV_{t-1} - CF_ext_t) / (NAV_{t-1} + CF_ext_t)
//   TWR_cum = Π(1 + r_t) - 1

'use strict';

// ── Date helpers ─────────────────────────────────────────────────────────────
function ymd(d) { return d.toISOString().slice(0, 10); }
function parseYMD(s) { return new Date(s + 'T00:00:00Z'); }
function addDays(s, n) {
  const d = parseYMD(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function eachDate(start, end) {
  const out = [];
  let cur = start;
  while (cur <= end) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

// ── Forward-fill prices ──────────────────────────────────────────────────────
// Build a map: ticker -> sorted [{date, close}] then for each calendar date in
// [start, end] return last-known close (or null if no prior price).
function buildPriceLookup(prices) {
  const byTicker = new Map();
  for (const p of prices) {
    if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, []);
    byTicker.get(p.ticker).push({ date: p.price_date, close: Number(p.close_native) });
  }
  for (const arr of byTicker.values()) arr.sort((a, b) => a.date < b.date ? -1 : 1);
  // returns fn(ticker, date) -> close or null
  return function priceOn(ticker, date) {
    const arr = byTicker.get(ticker);
    if (!arr || arr.length === 0) return null;
    // binary search last <= date
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].date <= date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best === -1 ? null : arr[best].close;
  };
}

// ── Cost basis (FIFO) ────────────────────────────────────────────────────────
// Walks tx in chronological order, maintains lots {qty, cost} per ticker.
// Returns:
//   positionsByDate: Map<date, Map<ticker, {qty, avg_cost, lots:[...]}>> -- snapshot AFTER processing all tx of that date
//   realizedPnlByDate: Map<date, number>
//   cashEffectByDate: Map<date, number>  -- USD cash impact from tx (BUY negative, SELL positive, fee always negative)
function fifoWalk(transactions) {
  const lots = new Map();    // ticker -> [{ qty, cost_per }]
  const realized = new Map();  // date -> usd
  const cashImpact = new Map(); // date -> usd
  const txByDate = new Map();   // date -> tx[] (for ordering)

  const sorted = [...transactions].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    // BUY before SELL same day to avoid negative qty
    return (a.side === 'BUY' ? 0 : 1) - (b.side === 'BUY' ? 0 : 1);
  });

  for (const tx of sorted) {
    const d = tx.trade_date;
    const fx = Number(tx.fx_to_usd) || 1;
    const qty = Number(tx.qty);
    const px = Number(tx.price_native);
    const fee = Number(tx.fee_native) || 0;
    const grossUsd = qty * px * fx;
    const feeUsd = fee * fx;

    if (!lots.has(tx.ticker)) lots.set(tx.ticker, []);
    const tickerLots = lots.get(tx.ticker);

    if (tx.side === 'BUY') {
      // cost per share = (gross + fee) / qty for cost basis
      const costPer = (grossUsd + feeUsd) / qty;
      tickerLots.push({ qty, cost_per: costPer });
      cashImpact.set(d, (cashImpact.get(d) || 0) - grossUsd - feeUsd);
    } else if (tx.side === 'SELL') {
      // FIFO consume
      let remaining = qty;
      let costRemoved = 0;
      while (remaining > 0 && tickerLots.length > 0) {
        const lot = tickerLots[0];
        const take = Math.min(lot.qty, remaining);
        costRemoved += take * lot.cost_per;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) tickerLots.shift();
      }
      const proceeds = grossUsd - feeUsd; // fee reduces proceeds
      const pnl = proceeds - costRemoved;
      realized.set(d, (realized.get(d) || 0) + pnl);
      cashImpact.set(d, (cashImpact.get(d) || 0) + proceeds);
    }

    if (!txByDate.has(d)) txByDate.set(d, []);
    txByDate.get(d).push(tx);
  }

  return { finalLots: lots, realizedByDate: realized, cashImpactByDate: cashImpact, txByDate };
}

// ── Replay engine: walk every calendar day, compute NAV ──────────────────────
function computeDaily({ transactions, cashflows, prices, iwquSeries, startDate, endDate }) {
  const priceOn = buildPriceLookup(prices);
  const iwquOn  = buildPriceLookup(iwquSeries.map(p => ({ ...p, ticker: '__IWQU__' })));

  // Sort tx & cf by date
  const sortedTx = [...transactions].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    return (a.side === 'BUY' ? 0 : 1) - (b.side === 'BUY' ? 0 : 1);
  });
  const sortedCf = [...cashflows].sort((a, b) => a.occurred_at < b.occurred_at ? -1 : 1);

  let txIdx = 0, cfIdx = 0;

  // State
  const lots = new Map();             // ticker -> [{qty, cost_per}]
  let cash = 0;                       // USD
  let totalContributions = 0;
  let totalWithdrawals = 0;
  let totalDividends = 0;
  let totalInterest = 0;
  let totalFeesCash = 0;
  let totalTaxes = 0;
  let realizedPnl = 0;

  const daily = [];
  let prevNav = 0;
  let twrCum = 1.0; // multiplicative
  let peakNav = 0;
  let iwquBase = null;

  const dates = eachDate(startDate, endDate);

  for (const date of dates) {
    // 1) Apply cashflows that occurred on this date (start of day, before tx)
    let externalFlowToday = 0; // contributions - withdrawals only (used for TWR)
    while (cfIdx < sortedCf.length && sortedCf[cfIdx].occurred_at <= date) {
      const cf = sortedCf[cfIdx];
      if (cf.occurred_at === date) {
        const fx = Number(cf.fx_to_usd) || 1;
        const amt = Number(cf.amount_native) * fx;
        switch (cf.cf_type) {
          case 'CONTRIBUTION':
            cash += Math.abs(amt); totalContributions += Math.abs(amt); externalFlowToday += Math.abs(amt); break;
          case 'WITHDRAWAL':
            cash -= Math.abs(amt); totalWithdrawals += Math.abs(amt); externalFlowToday -= Math.abs(amt); break;
          case 'DIVIDEND':
            cash += Math.abs(amt); totalDividends += Math.abs(amt); break;
          case 'INTEREST':
            cash += Math.abs(amt); totalInterest += Math.abs(amt); break;
          case 'FEE':
            cash -= Math.abs(amt); totalFeesCash += Math.abs(amt); break;
          case 'TAX':
            cash -= Math.abs(amt); totalTaxes += Math.abs(amt); break;
          default:
            // unknown type — treat as no-op
            break;
        }
      }
      cfIdx++;
    }

    // 2) Apply transactions for this date (after cashflows)
    while (txIdx < sortedTx.length && sortedTx[txIdx].trade_date <= date) {
      const tx = sortedTx[txIdx];
      if (tx.trade_date === date) {
        const fx = Number(tx.fx_to_usd) || 1;
        const qty = Number(tx.qty);
        const px = Number(tx.price_native);
        const fee = Number(tx.fee_native) || 0;
        const grossUsd = qty * px * fx;
        const feeUsd = fee * fx;

        if (!lots.has(tx.ticker)) lots.set(tx.ticker, []);
        const tickerLots = lots.get(tx.ticker);

        if (tx.side === 'BUY') {
          const costPer = (grossUsd + feeUsd) / qty;
          tickerLots.push({ qty, cost_per: costPer });
          cash -= (grossUsd + feeUsd);
        } else if (tx.side === 'SELL') {
          let remaining = qty;
          let costRemoved = 0;
          while (remaining > 0 && tickerLots.length > 0) {
            const lot = tickerLots[0];
            const take = Math.min(lot.qty, remaining);
            costRemoved += take * lot.cost_per;
            lot.qty -= take;
            remaining -= take;
            if (lot.qty <= 1e-9) tickerLots.shift();
          }
          const proceeds = grossUsd - feeUsd;
          realizedPnl += (proceeds - costRemoved);
          cash += proceeds;
        }
      }
      txIdx++;
    }

    // 3) Mark to market — value all positions at this date
    let mv = 0;
    let unrealizedPnl = 0;
    for (const [ticker, tickerLots] of lots) {
      const totalQty = tickerLots.reduce((s, l) => s + l.qty, 0);
      if (totalQty <= 1e-9) continue;
      const px = priceOn(ticker, date);
      if (px == null) continue; // before first price — skip valuation
      const cost = tickerLots.reduce((s, l) => s + l.qty * l.cost_per, 0);
      mv += totalQty * px;
      unrealizedPnl += (totalQty * px - cost);
    }
    const nav = cash + mv;

    // 4) TWR — Modified Dietz daily, external flow at start of day
    let r = 0;
    if (prevNav > 0 || externalFlowToday !== 0) {
      const denom = prevNav + externalFlowToday;
      if (denom > 0) r = (nav - prevNav - externalFlowToday) / denom;
    }
    twrCum *= (1 + r);
    if (nav > peakNav) peakNav = nav;
    const dd = peakNav > 0 ? (peakNav - nav) / peakNav : 0;

    // 5) IWQU.L benchmark — normalize to 1.0 at first date with both IWQU.L price & non-zero NAV
    const iwquPx = iwquOn('__IWQU__', date);
    if (iwquBase == null && iwquPx != null && nav > 0) iwquBase = iwquPx;
    const iwquNorm = (iwquBase != null && iwquPx != null) ? (iwquPx / iwquBase) : null;

    daily.push({
      date,
      nav: round2(nav),
      cash: round2(cash),
      market_value: round2(mv),
      external_flow: round2(externalFlowToday),
      twr_daily: r,
      twr_cum: twrCum - 1,
      drawdown: dd,
      iwqu_norm: iwquNorm,
      unrealized_pnl: round2(unrealizedPnl),
    });

    prevNav = nav;
  }

  // ── Final holdings ─────────────────────────────────────────────────────────
  const lastDate = dates[dates.length - 1];

  // Earliest BUY trade_date per ticker (for holding period + per-position IRR)
  const firstBuyByTicker = new Map();
  for (const tx of sortedTx) {
    if (tx.side !== 'BUY') continue;
    if (!firstBuyByTicker.has(tx.ticker) || tx.trade_date < firstBuyByTicker.get(tx.ticker)) {
      firstBuyByTicker.set(tx.ticker, tx.trade_date);
    }
  }

  const holdings = [];
  let totalMv = 0;
  for (const [ticker, tickerLots] of lots) {
    const totalQty = tickerLots.reduce((s, l) => s + l.qty, 0);
    if (totalQty <= 1e-9) continue;
    const cost = tickerLots.reduce((s, l) => s + l.qty * l.cost_per, 0);
    const avgCost = cost / totalQty;
    const px = priceOn(ticker, lastDate);
    const mv = px != null ? totalQty * px : null;
    if (mv != null) totalMv += mv;

    // Per-position annualized IRR: (mv/cost)^(365/days) - 1
    const fbd = firstBuyByTicker.get(ticker);
    let irrAnn = null, daysHeld = null;
    if (fbd && mv != null && cost > 0) {
      const ms = new Date(lastDate) - new Date(fbd);
      daysHeld = Math.max(1, Math.floor(ms / 86400000));
      const years = daysHeld / 365;
      if (years > 0) irrAnn = round4(Math.pow(mv / cost, 1 / years) - 1);
    }

    holdings.push({
      ticker,
      qty: totalQty,
      avg_cost: round4(avgCost),
      cost_basis: round2(cost),
      last_price: px != null ? round4(px) : null,
      market_value: mv != null ? round2(mv) : null,
      unrealized_pnl: (mv != null) ? round2(mv - cost) : null,
      first_buy_date: fbd || null,
      days_held: daysHeld,
      irr_annualized: irrAnn,
    });
  }
  // weights
  for (const h of holdings) {
    h.weight_pct = (h.market_value != null && totalMv > 0) ? round4(h.market_value / totalMv) : null;
  }
  holdings.sort((a, b) => (b.market_value || 0) - (a.market_value || 0));

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const last = daily[daily.length - 1] || { nav: 0, cash: 0, market_value: 0, twr_cum: 0, drawdown: 0, iwqu_norm: null };
  const navInvested = totalContributions - totalWithdrawals;
  const totalPnl = last.nav - navInvested;
  const totalRetPct = navInvested > 0 ? (last.nav / navInvested - 1) : 0;
  const maxDrawdown = daily.reduce((m, d) => Math.max(m, d.drawdown), 0);
  const iwquRet = (last.iwqu_norm != null) ? (last.iwqu_norm - 1) : null;

  // IRR — XIRR-style on external cashflows + terminal NAV
  const irrFlows = [];
  for (const cf of sortedCf) {
    const fx = Number(cf.fx_to_usd) || 1;
    const amt = Number(cf.amount_native) * fx;
    if (cf.cf_type === 'CONTRIBUTION') irrFlows.push({ date: cf.occurred_at, amount: -Math.abs(amt) });
    else if (cf.cf_type === 'WITHDRAWAL') irrFlows.push({ date: cf.occurred_at, amount: +Math.abs(amt) });
  }
  irrFlows.push({ date: lastDate, amount: last.nav });
  const irr = xirr(irrFlows);

  const inceptionDate = daily.find(d => d.nav > 0)?.date || startDate;
  const daysElapsed = Math.max(1, Math.round((parseYMD(lastDate) - parseYMD(inceptionDate)) / 86400000));

  return {
    dailySeries: daily,
    holdings,
    kpis: {
      nav: last.nav,
      cash_usd: last.cash,
      market_value_usd: last.market_value,
      invested_usd: round2(navInvested),
      total_contributions: round2(totalContributions),
      total_withdrawals: round2(totalWithdrawals),
      total_dividends: round2(totalDividends),
      total_interest: round2(totalInterest),
      total_fees_cash: round2(totalFeesCash),
      total_taxes: round2(totalTaxes),
      realized_pnl: round2(realizedPnl),
      unrealized_pnl: last.unrealized_pnl,
      total_pnl_usd: round2(totalPnl),
      total_return_pct: round4(totalRetPct),
      twr_cum_pct: round4(last.twr_cum),
      irr_pct: irr != null ? round4(irr) : null,
      max_drawdown_pct: round4(maxDrawdown),
      iwqu_return_pct: iwquRet != null ? round4(iwquRet) : null,
      inception_date: inceptionDate,
      last_date: lastDate,
      days_elapsed: daysElapsed,
    },
  };
}

// ── XIRR (Newton-Raphson) ────────────────────────────────────────────────────
function xirr(flows, guess = 0.1) {
  if (flows.length < 2) return null;
  const t0 = parseYMD(flows[0].date);
  const ts = flows.map(f => (parseYMD(f.date) - t0) / 86400000 / 365.25);
  const amts = flows.map(f => f.amount);
  const hasPos = amts.some(a => a > 0);
  const hasNeg = amts.some(a => a < 0);
  if (!hasPos || !hasNeg) return null;

  let r = guess;
  for (let iter = 0; iter < 100; iter++) {
    let f = 0, df = 0;
    for (let i = 0; i < amts.length; i++) {
      const denom = Math.pow(1 + r, ts[i]);
      f += amts[i] / denom;
      df += -ts[i] * amts[i] / (denom * (1 + r));
    }
    if (Math.abs(df) < 1e-12) break;
    const newR = r - f / df;
    if (!isFinite(newR)) break;
    if (Math.abs(newR - r) < 1e-7) return newR;
    r = newR;
    if (r < -0.999) r = -0.999;
  }
  return isFinite(r) ? r : null;
}

// ── Rounding helpers ─────────────────────────────────────────────────────────
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round4(x) { return Math.round((Number(x) || 0) * 10000) / 10000; }

module.exports = { computeDaily, fifoWalk, xirr, buildPriceLookup };
