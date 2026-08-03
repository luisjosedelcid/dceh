// Time deposits (bank CDs) — linear accrual valuation.
//
// Represented as synthetic Fixed Income holdings. Each day the mark-to-accrual
// value grows linearly by (principal * annual_rate * (1 - tax_rate) / 365).
// At maturity we clip to the terminal value.
//
// The engine here is intentionally standalone — no coupling to the Schwab-based
// perf engine. Consumers ask for a snapshot at a given date and get a holdings
// array they can merge into the consolidated view.

const { sbSelect } = require('./_supabase');

const DAYCOUNT_DENOMINATOR = {
  actual_365: 365,
  actual_360: 360,
  '30_360': 360,
};

function parseYMD(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(aYMD, bYMD) {
  return Math.round((parseYMD(bYMD) - parseYMD(aYMD)) / 86400000);
}

function clampDate(dateYMD, minYMD, maxYMD) {
  if (dateYMD < minYMD) return minYMD;
  if (dateYMD > maxYMD) return maxYMD;
  return dateYMD;
}

/**
 * Values a single time deposit as of a given date using linear accrual.
 *
 * Returns { mv, principal, accrued_gross, accrued_tax, accrued_net,
 *           days_elapsed, days_total, is_matured, ... }.
 */
function valueTimeDeposit(td, asOfYMD) {
  const start = td.start_date;
  const maturity = td.maturity_date;
  const principal = Number(td.principal);
  const rate = Number(td.annual_rate);
  const taxRate = Number(td.tax_rate || 0);
  const denom = DAYCOUNT_DENOMINATOR[td.day_count_convention] || 365;

  const daysTotal = daysBetween(start, maturity);
  const effectiveDate = clampDate(asOfYMD, start, maturity);
  const daysElapsed = Math.max(0, daysBetween(start, effectiveDate));
  const isMatured = asOfYMD >= maturity;

  // Linear accrual: gross_interest = principal * rate * days_elapsed / denom
  const accruedGross = principal * rate * daysElapsed / denom;
  const accruedTax = accruedGross * taxRate;
  const accruedNet = accruedGross - accruedTax;

  // MV grows by accrued net interest (bank pays net at maturity)
  const mv = principal + accruedNet;

  // At maturity: total gross/tax/net (terminal values, for reporting)
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
    day_count_convention: td.day_count_convention,
    payment_frequency: td.payment_frequency,
    status: td.status,
    days_elapsed: daysElapsed,
    days_total: daysTotal,
    days_remaining: Math.max(0, daysTotal - daysElapsed),
    pct_elapsed: daysTotal > 0 ? daysElapsed / daysTotal : 1,
    accrued_gross: Math.round(accruedGross * 100) / 100,
    accrued_tax: Math.round(accruedTax * 100) / 100,
    accrued_net: Math.round(accruedNet * 100) / 100,
    terminal_gross: Math.round(terminalGross * 100) / 100,
    terminal_tax: Math.round(terminalTax * 100) / 100,
    terminal_net: Math.round(terminalNet * 100) / 100,
    mv: Math.round(mv * 100) / 100,
    is_matured: isMatured,
    // Effective annualized yield after tax (for display)
    net_yield_annualized: rate * (1 - taxRate),
  };
}

/**
 * Loads all active/matured time deposits and values them as of the given date.
 */
async function loadAndValueTimeDeposits(asOfYMD) {
  const rows = await sbSelect(
    'time_deposits',
    "select=id,name,bank,currency,principal,start_date,maturity_date,annual_rate,tax_rate,day_count_convention,payment_frequency,status,notes&status=in.(active,matured)&order=start_date.asc"
  );
  const asOf = asOfYMD || new Date().toISOString().slice(0, 10);
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

module.exports = { valueTimeDeposit, loadAndValueTimeDeposits };
