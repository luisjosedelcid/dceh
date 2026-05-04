// Smoke test for _perf-calc.js — pulls real data from Supabase and validates arithmetic.
const { computeDaily } = require('../api/_perf-calc');

async function sb(query) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  const tx = await sb('transactions?select=trade_date,ticker,side,qty,price_native,fx_to_usd,fee_native&order=trade_date');
  const cf = await sb('cashflows?select=occurred_at,cf_type,ticker,amount_native,fx_to_usd&order=occurred_at');
  const allPrices = await sb('prices_daily?select=ticker,price_date,close_native&order=price_date');

  const iwquSeries = allPrices.filter(p => p.ticker === 'IWQU.L');
  const otherPrices = allPrices.filter(p => p.ticker !== 'IWQU.L');

  // Inception = earliest date
  const startDate = [...tx.map(t => t.trade_date), ...cf.map(c => c.occurred_at)].sort()[0];
  const endDate = '2026-04-30'; // current date in this session
  console.log(`Inception: ${startDate}, end: ${endDate}`);
  console.log(`Tx: ${tx.length}, Cf: ${cf.length}, Prices (non-IWQU.L): ${otherPrices.length}, IWQU.L: ${iwquSeries.length}`);

  const result = computeDaily({
    transactions: tx,
    cashflows: cf,
    prices: otherPrices,
    iwquSeries,
    startDate,
    endDate,
  });

  console.log('\n── KPIs ──');
  console.log(JSON.stringify(result.kpis, null, 2));

  console.log('\n── Holdings ──');
  for (const h of result.holdings) {
    console.log(`${h.ticker.padEnd(12)} qty=${String(h.qty).padStart(8)} avg_cost=${String(h.avg_cost).padStart(10)} cost_basis=${String(h.cost_basis).padStart(12)} mv=${String(h.market_value).padStart(12)} pnl=${String(h.unrealized_pnl).padStart(10)} w%=${(h.weight_pct*100).toFixed(2)}`);
  }

  console.log('\n── Smoke checks ──');
  const lulu = result.holdings.find(h => h.ticker === 'LULU');
  const ok1 = lulu && Math.abs(lulu.cost_basis - 99022.65) < 0.01;
  console.log(`LULU cost_basis = ${lulu?.cost_basis} (expected 99022.65) ${ok1 ? '✓' : '✗'}`);

  const msft = result.holdings.find(h => h.ticker === 'MSFT');
  const ok2 = msft && Math.abs(msft.cost_basis - 100278.75) < 0.01;
  console.log(`MSFT cost_basis = ${msft?.cost_basis} (expected 100278.75) ${ok2 ? '✓' : '✗'}`);

  // Total contributions = 1000 + 99000 + 75000 + 225000 = 400000
  const ok3 = Math.abs(result.kpis.total_contributions - 400000) < 0.01;
  console.log(`total_contributions = ${result.kpis.total_contributions} (expected 400000) ${ok3 ? '✓' : '✗'}`);

  // Treasury sold at par 1.0; bought at 0.99641933 -> realized pnl ~ 268.55
  const expectedTreasuryPnl = (1.00 - 0.99641933) * 75000;
  const ok4 = Math.abs(result.kpis.realized_pnl - expectedTreasuryPnl) < 0.5;
  console.log(`realized_pnl = ${result.kpis.realized_pnl} (expected ~${expectedTreasuryPnl.toFixed(2)}) ${ok4 ? '✓' : '✗'}`);

  // Print last 5 daily points
  console.log('\n── Last 5 days ──');
  for (const d of result.dailySeries.slice(-5)) {
    console.log(`${d.date} nav=${d.nav.toFixed(2)} cash=${d.cash.toFixed(2)} mv=${d.market_value.toFixed(2)} twr_cum=${(d.twr_cum*100).toFixed(2)}% dd=${(d.drawdown*100).toFixed(2)}% iwqu=${d.iwqu_norm?.toFixed(4) || '—'}`);
  }

  // Find peak NAV day
  let peak = 0, peakDay = '';
  for (const d of result.dailySeries) { if (d.nav > peak) { peak = d.nav; peakDay = d.date; } }
  console.log(`\nPeak NAV: ${peak.toFixed(2)} on ${peakDay}`);
  console.log(`Max DD: ${(result.kpis.max_drawdown_pct*100).toFixed(2)}%`);
})().catch(e => { console.error(e); process.exit(1); });
