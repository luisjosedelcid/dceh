// DCE Performance — pure computation engine
//
// Inputs (all USD-denominated; FX is folded in by callers via *_usd helpers below):
//   transactions: [{ trade_date:'YYYY-MM-DD', ticker, side:'BUY'|'SELL', qty, price_native, fee_native, fx_to_usd }]
//   cashflows:    [{ occurred_at:'YYYY-MM-DD', ticker?, cf_type:'CONTRIBUTION'|'WITHDRAWAL'|'DIVIDEND'|'INTEREST'|'FEE'|'TAX', amount_native, fx_to_usd }]
//   prices:       [{ price_date:'YYYY-MM-DD', ticker, close_native }]   (currency assumed USD here)
//   iwquSeries:   [{ price_date, close_native }]                         (SPY / S&P 500 benchmark; var name is legacy)
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
        // Honor signed amount_native. Manual entries store CONTRIBUTION/DIVIDEND/
        // INTEREST positive and WITHDRAWAL/FEE/TAX negative; Schwab CSV is signed
        // the same way. Math.abs + type-direction inverted Margin Interest (neg
        // INTEREST) and outbound MoneyLink (neg CONTRIBUTION).
        const amt = Number(cf.amount_native) * fx;
        if (!Number.isFinite(amt) || amt === 0) { cfIdx++; continue; }
        switch (cf.cf_type) {
          case 'CONTRIBUTION':
          case 'WITHDRAWAL': {
            // Direction from sign (covers mis-tagged MoneyLink / wires).
            if (amt >= 0) {
              cash += amt; totalContributions += amt; externalFlowToday += amt;
            } else {
              const w = -amt;
              cash -= w; totalWithdrawals += w; externalFlowToday -= w;
            }
            break;
          }
          case 'DIVIDEND':
            cash += amt; totalDividends += Math.abs(amt); break;
          case 'INTEREST':
            // Credit interest (+); margin interest (−) reduces cash.
            cash += amt;
            if (amt >= 0) totalInterest += amt;
            else totalFeesCash += -amt;
            break;
          case 'FEE':
          case 'TAX':
            cash += amt; // typically negative; refunds (rare +) add cash
            if (cf.cf_type === 'FEE') totalFeesCash += Math.abs(amt);
            else totalTaxes += Math.abs(amt);
            break;
          default:
            // unknown type — apply signed cash impact conservatively
            cash += amt;
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
      const cost = tickerLots.reduce((s, l) => s + l.qty * l.cost_per, 0);
      let px = priceOn(ticker, date);
      if (px == null) {
        // Fallback: for instruments without a market price on this date
        // (T-bill CUSIPs, private assets, freshly opened positions before
        // the price backfill catches up), value at average cost. This is
        // the correct treatment for hold-to-maturity Treasuries and any
        // asset without a quotable market — no phantom ‘$0’ hole in NAV.
        px = totalQty > 0 ? cost / totalQty : 0;
      }
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

    // 5) Benchmark (SPY / S&P 500) — normalize to 1.0 at first date with both a SPY close & non-zero NAV.
    //    Field names (iwqu_*) are legacy; the series is SPY now.
    const iwquPx = iwquOn('__IWQU__', date);
    if (iwquBase == null && iwquPx != null && nav > 0) iwquBase = iwquPx;
    const iwquNorm = (iwquBase != null && iwquPx != null) ? (iwquPx / iwquBase) : null;

    daily.push({
      date,
      nav: round2(nav),
      cash: round2(cash),
      market_value: round2(mv),
      invested: round2(totalContributions - totalWithdrawals), // net contributions to date
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
  const notesByTicker = new Map();
  for (const tx of sortedTx) {
    if (tx.side !== 'BUY') continue;
    if (!firstBuyByTicker.has(tx.ticker) || tx.trade_date < firstBuyByTicker.get(tx.ticker)) {
      firstBuyByTicker.set(tx.ticker, tx.trade_date);
    }
    // Keep first non-empty notes for each ticker (for security description parsing)
    if (!notesByTicker.has(tx.ticker) && tx.notes) {
      notesByTicker.set(tx.ticker, tx.notes);
    }
  }

  // Parse T-bill / Treasury security description from Schwab notes.
  // Schwab notes format: 'US TREASURY BILL26U S T BILL DUE 11/03/26'
  // Return { display: 'UST BILL 11/03/26', maturity: '2026-11-03' }.
  // For non-Treasury tickers, returns null.
  function parseTreasuryMeta(ticker, notes) {
    if (!ticker || !notes) return null;
    if (!/^912[0-9A-Z]{6}$/.test(ticker)) return null; // only Treasury CUSIPs
    const m = notes.match(/DUE\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
    if (!m) return null;
    const [, mm, dd, yy] = m;
    const year = yy.length === 2 ? '20' + yy : yy;
    const isBill = /BILL/i.test(notes);
    const isNote = /NOTE|NT/i.test(notes) && !isBill;
    const kind = isBill ? 'UST BILL' : (isNote ? 'UST NOTE' : 'UST');
    return {
      display: `${kind} ${mm.padStart(2,'0')}/${dd.padStart(2,'0')}/${yy.slice(-2)}`,
      maturity: `${year}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`,
    };
  }

  // Asset class classification (SEC/GAAP cash-equivalents rule).
  // - cash_equivalent: ultra-short T-bill / money-market ETFs (effective maturity <=90d)
  //   -> aggregated into cash_usd bucket at KPI level
  // - fixed_income: individual T-bill CUSIPs, T-notes, corporate/agency/muni bonds
  // - equity: everything else (public equities, ADRs)
  // Cash (uninvested USD balance) is tracked separately via `cash_usd`.
  // (classifyAssetClass is module-level — see below.)

  const holdings = [];
  let totalMv = 0;
  let mvEquity = 0;
  let mvFixedIncome = 0;
  let mvCashEquivalent = 0;
  for (const [ticker, tickerLots] of lots) {
    const totalQty = tickerLots.reduce((s, l) => s + l.qty, 0);
    if (totalQty <= 1e-9) continue;
    const cost = tickerLots.reduce((s, l) => s + l.qty * l.cost_per, 0);
    const avgCost = cost / totalQty;
    let px = priceOn(ticker, lastDate);
    let pxSource = 'market';
    if (px == null) {
      // Same fallback as the daily MV loop: value at average cost when no
      // market price is available (T-bill CUSIPs, private assets, etc.).
      px = avgCost;
      pxSource = 'cost';
    }
    const mv = totalQty * px;
    totalMv += mv;

    // Per-position annualized IRR: (mv/cost)^(365/days) - 1
    const fbd = firstBuyByTicker.get(ticker);
    let irrAnn = null, daysHeld = null;
    if (fbd && cost > 0) {
      const ms = new Date(lastDate) - new Date(fbd);
      daysHeld = Math.max(1, Math.floor(ms / 86400000));
      const years = daysHeld / 365;
      if (years > 0) irrAnn = round4(Math.pow(mv / cost, 1 / years) - 1);
    }

    const assetClass = classifyAssetClass(ticker);
    if (assetClass === 'fixed_income') mvFixedIncome += mv;
    else if (assetClass === 'cash_equivalent') mvCashEquivalent += mv;
    else mvEquity += mv;

    // Security description (Treasury CUSIPs get parsed display + maturity)
    const meta = parseTreasuryMeta(ticker, notesByTicker.get(ticker));
    holdings.push({
      ticker,
      qty: totalQty,
      avg_cost: round4(avgCost),
      cost_basis: round2(cost),
      last_price: round4(px),
      last_price_source: pxSource,
      market_value: round2(mv),
      unrealized_pnl: round2(mv - cost),
      asset_class: assetClass,
      first_buy_date: fbd || null,
      days_held: daysHeld,
      irr_annualized: irrAnn,
      security_display: meta ? meta.display : null,
      maturity_date: meta ? meta.maturity : null,
    });
  }
  // ── weights: use NAV as denominator ─────────────────────────────────────────
  // Weights against MV would sum to 100% but leave cash out of the picture,
  // and would use a different denominator than the IPS bands (which use NAV).
  // Standardize on NAV: weights of open positions sum to (mv / nav) < 100%,
  // with the remainder being cash. Matches how IPS bands read allocation.
  const last = daily[daily.length - 1] || { nav: 0, cash: 0, market_value: 0, twr_cum: 0, drawdown: 0, iwqu_norm: null };
  const navForWeights = last.nav;
  for (const h of holdings) {
    h.weight_pct = (h.market_value != null && navForWeights > 0) ? round4(h.market_value / navForWeights) : null;
  }
  holdings.sort((a, b) => (b.market_value || 0) - (a.market_value || 0));

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const navInvested = totalContributions - totalWithdrawals;
  const totalPnl = last.nav - navInvested;
  const totalRetPct = navInvested > 0 ? (last.nav / navInvested - 1) : 0;
  const maxDrawdown = daily.reduce((m, d) => Math.max(m, d.drawdown), 0);
  const iwquRet = (last.iwqu_norm != null) ? (last.iwqu_norm - 1) : null;

  // IRR — XIRR-style on external cashflows + terminal NAV.
  // Convention: money into the portfolio is negative; money out is positive.
  // amount_native is the opposite sign (contribution +, withdrawal −) → negate.
  const irrFlows = [];
  for (const cf of sortedCf) {
    const fx = Number(cf.fx_to_usd) || 1;
    const amt = Number(cf.amount_native) * fx;
    if (!Number.isFinite(amt) || amt === 0) continue;
    if (cf.cf_type === 'CONTRIBUTION' || cf.cf_type === 'WITHDRAWAL') {
      irrFlows.push({ date: cf.occurred_at, amount: -amt });
    }
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
      mv_equity_usd: round2(mvEquity),
      mv_fixed_income_usd: round2(mvFixedIncome),
      mv_cash_equivalent_usd: round2(mvCashEquivalent),
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

// ── XIRR (Newton-Raphson with bisection fallback) ────────────────────────────
function xirr(flows, guess = 0.1) {
  if (flows.length < 2) return null;
  const t0 = parseYMD(flows[0].date);
  const ts = flows.map(f => (parseYMD(f.date) - t0) / 86400000 / 365.25);
  const amts = flows.map(f => f.amount);
  const hasPos = amts.some(a => a > 0);
  const hasNeg = amts.some(a => a < 0);
  if (!hasPos || !hasNeg) return null;

  // NPV as a function of rate r
  const npv = (r) => {
    let f = 0;
    for (let i = 0; i < amts.length; i++) f += amts[i] / Math.pow(1 + r, ts[i]);
    return f;
  };

  // 1) Newton-Raphson from guess
  let r = guess;
  let converged = false;
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
    if (Math.abs(newR - r) < 1e-9) { r = newR; converged = true; break; }
    r = newR;
    if (r < -0.999) r = -0.999;
    if (r > 100) r = 100; // hard cap while iterating; > 10,000% ann is nonsense
  }

  // Reject Newton result if it's outside a sane band (-99% to +1000% ann)
  if (converged && isFinite(r) && r > -0.999 && r <= 10 && Math.abs(npv(r)) < 1e-2) {
    return r;
  }

  // 2) Bisection fallback over [-0.99, 10] (i.e. -99% to +1000% ann)
  let lo = -0.99, hi = 10;
  let nLo = npv(lo), nHi = npv(hi);
  if (nLo * nHi > 0) return null; // no sign change — no real root in this band
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 1e-3 || (hi - lo) < 1e-8) return mid;
    if (nLo * nMid < 0) { hi = mid; nHi = nMid; } else { lo = mid; nLo = nMid; }
  }
  return (lo + hi) / 2;
}

// ── Rounding helpers ─────────────────────────────────────────────────────────
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function round4(x) { return Math.round((Number(x) || 0) * 10000) / 10000; }

// Shared cash-equivalent ETF allowlist (keep in sync with Research grid filter).
const CASH_EQUIVALENT_TICKERS = new Set([
  'SGOV', 'BIL', 'GBIL', 'CLIP',
  'SHV', 'SHY', 'VGSH', 'VBIL', 'TBIL', 'USFR',
  'XHLF', 'CLTL', 'MINT',
]);

function classifyAssetClass(ticker) {
  if (!ticker) return 'equity';
  const t = String(ticker).toUpperCase();
  if (CASH_EQUIVALENT_TICKERS.has(t)) return 'cash_equivalent';
  // Individual T-bill/T-note CUSIPs: 9 chars, alphanumeric, starts with 912
  if (/^912[0-9A-Z]{6}$/.test(t)) return 'fixed_income';
  return 'equity';
}

module.exports = {
  computeDaily, fifoWalk, xirr, buildPriceLookup,
  classifyAssetClass, CASH_EQUIVALENT_TICKERS,
};
