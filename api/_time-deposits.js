// Time deposits (bank CDs) — linear accrual valuation.
//
// Represented as synthetic Fixed Income holdings. Each day the mark-to-accrual
// value grows linearly by (principal * annual_rate * (1 - tax_rate) / denom).
// At maturity we clip to the terminal value.
//
// The engine here is intentionally standalone — no coupling to the Schwab-based
// perf engine. Consumers ask for a snapshot at a given date and get a holdings
// array they can merge into the consolidated view.

const { sbSelect, sbUpdate } = require('./_supabase');

const DAYCOUNT_DENOMINATOR = {
  actual_365: 365,
  actual_360: 360,
  '30_360': 360,
};

const PORTFOLIO_TZ = 'America/Guatemala';

function parseYMD(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetweenActual(aYMD, bYMD) {
  return Math.round((parseYMD(bYMD) - parseYMD(aYMD)) / 86400000);
}

/**
 * US/NASD 30/360 day count (numerator).
 * - If D1 is 31 → 30
 * - If D2 is 31 and D1 is 30 or 31 → D2 = 30
 */
function daysBetween360(startYMD, endYMD) {
  let [y1, m1, d1] = String(startYMD).split('-').map(Number);
  let [y2, m2, d2] = String(endYMD).split('-').map(Number);
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 >= 30) d2 = 30;
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

function daysBetween(aYMD, bYMD, convention) {
  if (convention === '30_360') return daysBetween360(aYMD, bYMD);
  return daysBetweenActual(aYMD, bYMD);
}

function clampDate(dateYMD, minYMD, maxYMD) {
  if (dateYMD < minYMD) return minYMD;
  if (dateYMD > maxYMD) return maxYMD;
  return dateYMD;
}

function todayInPortfolioTZ() {
  // en-CA → YYYY-MM-DD
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: PORTFOLIO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function periodMonths(freq) {
  switch (String(freq || 'bullet').toLowerCase()) {
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'semi_annual':
    case 'semiannual':
    case 'semi-annual': return 6;
    case 'annual': return 12;
    default: return null; // bullet / unknown → full accrual into MV
  }
}

/** Last coupon date on or before asOf (for non-bullet payment frequencies). */
function lastCouponOnOrBefore(startYMD, asOfYMD, months) {
  if (!months || asOfYMD <= startYMD) return startYMD;
  const start = parseYMD(startYMD);
  const asOf = parseYMD(asOfYMD);
  let last = startYMD;
  // Walk forward in period steps; cap iterations for safety.
  for (let i = 0; i < 600; i++) {
    const next = new Date(start);
    next.setUTCMonth(start.getUTCMonth() + months * (i + 1));
    const ymd = next.toISOString().slice(0, 10);
    if (ymd > asOfYMD || next > asOf) break;
    last = ymd;
  }
  return last < startYMD ? startYMD : last;
}

/**
 * Values a single time deposit as of a given date using linear accrual.
 */
function valueTimeDeposit(td, asOfYMD) {
  const start = td.start_date;
  const maturity = td.maturity_date;
  const principal = Number(td.principal);
  const rate = Number(td.annual_rate);
  const taxRate = Number(td.tax_rate || 0);
  const convention = td.day_count_convention || 'actual_365';
  const denom = DAYCOUNT_DENOMINATOR[convention] || 365;
  const freq = td.payment_frequency || 'bullet';
  const months = periodMonths(freq);

  const daysTotal = Math.max(0, daysBetween(start, maturity, convention));
  const effectiveDate = clampDate(asOfYMD, start, maturity);
  const isMatured = asOfYMD >= maturity;

  // Non-bullet: only accrue interest since the last coupon payment (paid-out
  // coupons leave the CD and must not stay in MV). Bullet: accrue from start.
  const accrualStart = months
    ? lastCouponOnOrBefore(start, effectiveDate, months)
    : start;
  const daysElapsed = Math.max(0, daysBetween(accrualStart, effectiveDate, convention));
  const daysFromStart = Math.max(0, daysBetween(start, effectiveDate, convention));

  const accruedGross = principal * rate * daysElapsed / denom;
  const accruedTax = accruedGross * taxRate;
  const accruedNet = accruedGross - accruedTax;
  const mv = principal + accruedNet;

  // Terminal values use full start→maturity span (bullet economic total).
  const terminalGross = principal * rate * daysTotal / denom;
  const terminalTax = terminalGross * taxRate;
  const terminalNet = terminalGross - terminalTax;

  return {
    id: td.id,
    name: td.name,
    bank: td.bank,
    currency: td.currency,
    principal,
    annual_rate: rate,
    tax_rate: taxRate,
    start_date: start,
    maturity_date: maturity,
    day_count_convention: convention,
    payment_frequency: freq,
    status: td.status,
    days_elapsed: daysFromStart,
    days_total: daysTotal,
    days_remaining: Math.max(0, daysTotal - daysFromStart),
    pct_elapsed: daysTotal > 0 ? Math.min(1, daysFromStart / daysTotal) : 1,
    accrued_gross: Math.round(accruedGross * 100) / 100,
    accrued_tax: Math.round(accruedTax * 100) / 100,
    accrued_net: Math.round(accruedNet * 100) / 100,
    terminal_gross: Math.round(terminalGross * 100) / 100,
    terminal_tax: Math.round(terminalTax * 100) / 100,
    terminal_net: Math.round(terminalNet * 100) / 100,
    mv: Math.round(mv * 100) / 100,
    is_matured: isMatured,
    net_yield_annualized: rate * (1 - taxRate),
  };
}

/**
 * Loads active/matured time deposits (excludes redeemed) and values them.
 * Auto-flips status active → matured when past maturity_date.
 */
async function loadAndValueTimeDeposits(asOfYMD) {
  const rows = await sbSelect(
    'time_deposits',
    "select=id,name,bank,currency,principal,start_date,maturity_date,annual_rate,tax_rate,day_count_convention,payment_frequency,status,notes&status=in.(active,matured)&order=start_date.asc"
  );
  const asOf = asOfYMD || todayInPortfolioTZ();

  // Auto-mark matured (best-effort; valuation still works off dates).
  for (const td of rows) {
    if (td.status === 'active' && asOf >= td.maturity_date) {
      try {
        await sbUpdate('time_deposits', `id=eq.${td.id}`, { status: 'matured' });
        td.status = 'matured';
      } catch (_) { /* non-blocking */ }
    }
  }

  const valued = rows.map(td => valueTimeDeposit(td, asOf));

  const totalPrincipal = valued.reduce((s, td) => s + td.principal, 0);
  const totalMv = valued.reduce((s, td) => s + td.mv, 0);
  const totalAccruedNet = valued.reduce((s, td) => s + td.accrued_net, 0);
  const totalAccruedGross = valued.reduce((s, td) => s + td.accrued_gross, 0);
  const totalAccruedTax = valued.reduce((s, td) => s + td.accrued_tax, 0);

  return {
    as_of: asOf,
    deposits: valued,
    kpis: {
      count: valued.length,
      total_principal: Math.round(totalPrincipal * 100) / 100,
      total_mv: Math.round(totalMv * 100) / 100,
      total_accrued_gross: Math.round(totalAccruedGross * 100) / 100,
      total_accrued_tax: Math.round(totalAccruedTax * 100) / 100,
      total_accrued_net: Math.round(totalAccruedNet * 100) / 100,
    },
  };
}

/**
 * Mark a deposit as redeemed (funds booked elsewhere — drop from MV totals).
 */
async function redeemTimeDeposit(id) {
  const rows = await sbSelect(
    'time_deposits',
    `select=id,status,name,notes&id=eq.${encodeURIComponent(id)}&limit=1`
  );
  if (!rows || !rows.length) {
    const err = new Error('Time deposit not found');
    err.status = 404;
    throw err;
  }
  const row = rows[0];
  if (row.status === 'redeemed') {
    return { ok: true, already: true, id: row.id };
  }
  const stamp = `redeemed_at=${todayInPortfolioTZ()}`;
  const notes = row.notes ? `${row.notes} | ${stamp}` : stamp;
  await sbUpdate('time_deposits', `id=eq.${row.id}`, {
    status: 'redeemed',
    notes,
  });
  return { ok: true, id: row.id, status: 'redeemed' };
}

module.exports = {
  valueTimeDeposit,
  loadAndValueTimeDeposits,
  redeemTimeDeposit,
  daysBetween360,
  todayInPortfolioTZ,
};
