// Schwab "All Transactions" CSV parser.
//
// Maps each Schwab row into either a `transactions` row (BUY/SELL) or a
// `cashflows` row (DIVIDEND, INTEREST, FEE, TAX, CONTRIBUTION, WITHDRAWAL).
//
// Currency: this account is USD-denominated. Schwab reports everything in
// USD already, so currency='USD' and fx_to_usd=1.0 for all rows.
//
// External IDs: Schwab CSV doesn't provide a transaction ID, so we synthesize
// a stable hash from `date|action|symbol|amount|qty|price` to make re-imports
// idempotent. Using the same CSV (or a superset) twice will not duplicate.

const crypto = require('crypto');

// ── Action mapping ────────────────────────────────────────────────────
// Each Schwab action maps to either:
//   { kind: 'tx',  side: 'BUY'|'SELL' }
//   { kind: 'cf',  cf_type: '...' }
//   { kind: 'skip' }    // intentional no-op (e.g. accounting adjustments
//                       // already captured by the parent action)
const ACTION_MAP = {
  // ── Trades ──
  'Buy':                   { kind: 'tx', side: 'BUY' },
  'Sell':                  { kind: 'tx', side: 'SELL' },
  'Reinvest Shares':       { kind: 'tx', side: 'BUY'  }, // DRIP buy from a div
  'Full Redemption':       { kind: 'tx', side: 'SELL' }, // bond matures → cash
  // The "Adj" leg of a redemption is the cash-side accounting entry. The
  // SELL leg already records the proceeds via the matching cashflow, so
  // we skip the adjustment to avoid double-counting.
  'Full Redemption Adj':   { kind: 'skip' },

  // ── Income ──
  'Cash Dividend':         { kind: 'cf', cf_type: 'DIVIDEND' },
  'Qualified Dividend':    { kind: 'cf', cf_type: 'DIVIDEND' },
  'Reinvest Dividend':     { kind: 'cf', cf_type: 'DIVIDEND' },
  'Bond Interest':         { kind: 'cf', cf_type: 'INTEREST' },
  'Credit Interest':       { kind: 'cf', cf_type: 'INTEREST' }, // cash sweep
  'Margin Interest':       { kind: 'cf', cf_type: 'INTEREST' },

  // ── Taxes & Fees ──
  'NRA Tax':               { kind: 'cf', cf_type: 'TAX' },     // withholding
  'NRA Tax Adj':           { kind: 'cf', cf_type: 'TAX' },     // withholding adj
  'Service Fee':           { kind: 'cf', cf_type: 'FEE' },
  'Wire Fee':              { kind: 'cf', cf_type: 'FEE' },
  'Foreign Tax Paid':      { kind: 'cf', cf_type: 'TAX' },

  // ── Capital flows ──
  'Wire Received':         { kind: 'cf', cf_type: 'CONTRIBUTION' },
  'Wire Sent':             { kind: 'cf', cf_type: 'WITHDRAWAL' },
  'Journaled Shares':      { kind: 'skip' }, // share movements between accts
  'MoneyLink Transfer':    { kind: 'cf', cf_type: 'CONTRIBUTION' }, // ACH in
};

// ── Parsing helpers ───────────────────────────────────────────────────
function parseAmount(s) {
  if (!s || s === '') return 0;
  // Remove $, commas, surrounding whitespace; keep leading - sign.
  const cleaned = String(s).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseQty(s) {
  if (!s || s === '') return 0;
  // Schwab quantities can be negative for redemptions (-75,000) or comma-
  // separated for thousands (1,225). Take absolute value — `side` carries
  // the direction.
  const cleaned = String(s).replace(/[,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function parseDate(s) {
  // Schwab uses MM/DD/YYYY. May include "as of MM/DD/YYYY" suffix — take the
  // first date (the trade/post date) for consistency.
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`; // ISO YYYY-MM-DD
}

// Naive RFC-4180 CSV split: handles quoted fields with commas inside.
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function makeExternalId({ date, action, symbol, qty, price, amount }) {
  // Stable hash → idempotent re-imports of overlapping CSVs.
  const key = [date, action, symbol || '', qty, price, amount].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// ── Main parser ───────────────────────────────────────────────────────
// Input: the full CSV text.
// Output: { transactions: [...], cashflows: [...], skipped: [...], errors: [...] }
function parseSchwabCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    return { transactions: [], cashflows: [], skipped: [], errors: ['Empty CSV'] };
  }

  const header = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
  const expected = ['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'];
  const missing = expected.filter(h => !header.includes(h));
  if (missing.length) {
    return {
      transactions: [], cashflows: [], skipped: [],
      errors: [`CSV missing expected headers: ${missing.join(', ')}. Got: ${header.join(', ')}`],
    };
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const transactions = [];
  const cashflows = [];
  const skipped = [];
  const errors = [];

  for (let li = 1; li < lines.length; li++) {
    const raw = lines[li];
    const cols = splitCsvLine(raw).map(s => s.replace(/^"|"$/g, ''));
    if (cols.length < expected.length) {
      errors.push({ line: li + 1, raw, error: 'Column count mismatch' });
      continue;
    }

    const row = {
      date:   cols[idx['Date']],
      action: cols[idx['Action']],
      symbol: cols[idx['Symbol']] || null,
      desc:   cols[idx['Description']] || '',
      qty:    cols[idx['Quantity']],
      price:  cols[idx['Price']],
      fee:    cols[idx['Fees & Comm']],
      amount: cols[idx['Amount']],
    };

    const mapping = ACTION_MAP[row.action];
    if (!mapping) {
      errors.push({ line: li + 1, raw, error: `Unknown action: ${row.action}` });
      continue;
    }

    if (mapping.kind === 'skip') {
      skipped.push({ line: li + 1, action: row.action, reason: 'intentional skip' });
      continue;
    }

    const isoDate = parseDate(row.date);
    if (!isoDate) {
      errors.push({ line: li + 1, raw, error: 'Bad date' });
      continue;
    }

    const qty = parseQty(row.qty);
    const price = parseAmount(row.price);
    const fee = parseAmount(row.fee);
    const amount = parseAmount(row.amount);
    const externalId = makeExternalId({
      date: isoDate, action: row.action, symbol: row.symbol,
      qty: row.qty, price: row.price, amount: row.amount,
    });

    if (mapping.kind === 'tx') {
      // SELL: Schwab's qty is negative (e.g. -75,000); we already abs-ed it.
      //
      // Bond convention: Schwab reports qty = face value (e.g. 75,000) and
      // price = % of par (e.g. 99.4235 means 99.4235% of par). This means
      // qty * price ≠ amount in dollars — we want a "price per unit" such
      // that qty * price = amount paid/received in USD, so cost basis math
      // is uniform across stocks and bonds.
      //
      // Strategy:
      //  1. If amount and qty are both present and non-zero, derive price
      //     from |amount|/qty. This handles bonds and any case where price
      //     differs from amount/qty due to accrued interest, fees, etc.
      //  2. Full Redemption rows have empty amount on the SELL line (the
      //     dollar amount is on the matching "Full Redemption Adj" line
      //     which we skip). For these, fall back to price=1.0 — because
      //     Schwab quotes redemption qty in face dollars and the proceeds
      //     equal face for at-par redemptions. So qty*1 = $face = amount.
      let derivedPrice = price;
      if (qty > 0 && amount !== 0) {
        // Use amount/qty so qty * price == |amount| in dollars.
        derivedPrice = Math.abs(amount) / qty;
      } else if (derivedPrice === 0 && row.action === 'Full Redemption') {
        // Bond redeemed at par: face dollars = USD proceeds.
        derivedPrice = 1.0;
      }
      transactions.push({
        ticker:        row.symbol,
        side:          mapping.side,
        qty,
        price_native:  derivedPrice,
        currency:      'USD',
        fx_to_usd:     1.0,
        fee_native:    fee,
        trade_date:    isoDate,
        source:        'schwab_csv',
        external_id:   externalId,
        notes:         row.desc,
      });
    } else if (mapping.kind === 'cf') {
      cashflows.push({
        cf_type:       mapping.cf_type,
        ticker:        row.symbol,         // null for account-level cashflows
        amount_native: amount,              // signed: -$84.38 (tax) or $364.40 (div)
        currency:      'USD',
        fx_to_usd:     1.0,
        occurred_at:   isoDate,
        source:        'schwab_csv',
        external_id:   externalId,
        notes:         row.desc,
      });
    }
  }

  return { transactions, cashflows, skipped, errors };
}

module.exports = { parseSchwabCsv, ACTION_MAP };
