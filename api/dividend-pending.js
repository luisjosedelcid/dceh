// GET /api/dividend-pending
// Returns soft pending dividends + interest for the rest of the calendar year.
//
// Pending = sum over all future dividend_schedule entries (declared + forecast)
//           where payment_date > today AND payment_date <= year_end,
//           multiplied by current net shares held per ticker (from trades).
//           Excludes entries whose ex_date has already passed but pay_date is still future
//           ONLY IF the position was sold before ex_date (we still owe them the payment).
//
// Output:
//   {
//     ok: true,
//     as_of: 'YYYY-MM-DD',
//     year_end: 'YYYY-MM-DD',
//     total_pending_usd: 1234.56,
//     declared_usd: 227.50,
//     forecast_usd: 455.00,
//     interest_pending_usd: 0,
//     breakdown: [
//       { ticker, shares, per_share_amount, payment_date, status, amount_usd, source_url }
//     ]
//   }
//
// Note: interest_pending stays at 0 until we add a cash_sweep_rate setting.

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function yearEndStr() {
  const y = new Date().getUTCFullYear();
  return `${y}-12-31`;
}

// Compute net shares per ticker from trades up to a given date.
// Assumes only BUY/SELL trade_types affect the share count.
async function getNetSharesByTicker(asOf) {
  const trades = await sbSelect(
    'trades',
    `select=ticker,trade_type,shares,trade_date&trade_date=lte.${encodeURIComponent(asOf)}`
  );
  const map = {};
  for (const t of trades) {
    if (!t.ticker) continue;
    const sh = parseFloat(t.shares || 0);
    if (!isFinite(sh)) continue;
    const key = String(t.ticker).toUpperCase();
    const sign = (String(t.trade_type || '').toUpperCase() === 'SELL') ? -1 : 1;
    map[key] = (map[key] || 0) + sign * sh;
  }
  return map;
}

// Core computation (reusable from other server endpoints)
async function computePendingDividends() {
  const today = todayStr();
  const yend = yearEndStr();

  const schedule = await sbSelect(
    'dividend_schedule',
    `select=*&payment_date=gte.${today}&payment_date=lte.${yend}&order=payment_date.asc`
  );

  if (!schedule || schedule.length === 0) {
    return { ok: true, as_of: today, year_end: yend, total_pending_usd: 0, declared_usd: 0, forecast_usd: 0, interest_pending_usd: 0, breakdown: [] };
  }

  const shareMap = await getNetSharesByTicker(today);
  let declared = 0;
  let forecast = 0;
  const breakdown = [];

  for (const row of schedule) {
    const ticker = String(row.ticker || '').toUpperCase();
    const shares = shareMap[ticker] || 0;
    if (shares <= 0) continue;
    const perShare = parseFloat(row.per_share_amount || 0);
    if (!isFinite(perShare) || perShare <= 0) continue;
    const amount = +(shares * perShare).toFixed(2);
    if (row.status === 'declared') declared += amount;
    else forecast += amount;
    breakdown.push({
      ticker, shares, per_share_amount: perShare,
      currency: row.currency || 'USD',
      ex_date: row.ex_date, payment_date: row.payment_date,
      status: row.status, amount_usd: amount,
      source_url: row.source_url || null,
    });
  }

  const interestPending = 0;
  return {
    ok: true, as_of: today, year_end: yend,
    total_pending_usd: +(declared + forecast + interestPending).toFixed(2),
    declared_usd: +declared.toFixed(2),
    forecast_usd: +forecast.toFixed(2),
    interest_pending_usd: interestPending,
    breakdown,
  };
}

const handler = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status || 401).json({ ok: false, error: auth.error || 'Unauthorized' });
      return;
    }

    const result = await computePendingDividends();
    res.status(200).json(result);
  } catch (err) {
    console.error('[dividend-pending] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
};

module.exports = handler;
module.exports.computePendingDividends = computePendingDividends;
