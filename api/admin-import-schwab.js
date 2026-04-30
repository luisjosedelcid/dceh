// POST /api/admin-import-schwab
// Body: raw CSV text (Schwab "All-Brokerage_Transactions" export)
// Header: x-admin-token
// Query: ?dryRun=1 (default) returns parse preview WITHOUT writing.
//        ?dryRun=0 writes to transactions + cashflows (idempotent via source+external_id).
//
// Returns: { ok, dryRun, summary, transactions, cashflows, skipped, errors }
//
// Idempotency: each row has source='schwab_csv' and external_id derived from
// (date|action|symbol|qty|amount|fees) so re-importing the same CSV is a no-op.

const { requireRole } = require('./_require-role');
const { sbUpsert, sbInsert } = require('./_supabase');
const { parseSchwabCsv } = require('./_schwab-parser');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const actor = auth.user.email || 'unknown';

  // Read raw body (CSV text)
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'CSV too large (max 10 MB)' });
      return;
    }
    chunks.push(chunk);
  }
  const csvText = Buffer.concat(chunks).toString('utf8');
  if (!csvText.trim()) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  // Parse
  let parsed;
  try {
    parsed = parseSchwabCsv(csvText);
  } catch (e) {
    res.status(400).json({ error: 'Parse failed', detail: String(e).slice(0, 300) });
    return;
  }

  const summary = {
    transactions: parsed.transactions.length,
    cashflows: parsed.cashflows.length,
    skipped: parsed.skipped.length,
    errors: parsed.errors.length,
    dateRange: dateRange(parsed),
    netContribution: parsed.cashflows
      .filter(c => c.cf_type === 'CONTRIBUTION' || c.cf_type === 'WITHDRAWAL')
      .reduce((s, c) => s + Number(c.amount_native || 0), 0),
  };

  const dryRun = req.query.dryRun !== '0';
  if (dryRun) {
    res.status(200).json({
      ok: true,
      dryRun: true,
      summary,
      transactions: parsed.transactions,
      cashflows: parsed.cashflows,
      skipped: parsed.skipped,
      errors: parsed.errors,
    });
    return;
  }

  // Commit: upsert transactions then cashflows
  let txInserted = 0;
  let cfInserted = 0;
  try {
    if (parsed.transactions.length > 0) {
      const out = await sbUpsert('transactions', parsed.transactions, 'source,external_id');
      txInserted = Array.isArray(out) ? out.length : 0;
    }
    if (parsed.cashflows.length > 0) {
      const out = await sbUpsert('cashflows', parsed.cashflows, 'source,external_id');
      cfInserted = Array.isArray(out) ? out.length : 0;
    }
  } catch (e) {
    res.status(500).json({ error: 'Database upsert failed', detail: String(e).slice(0, 300) });
    return;
  }

  // Audit (best-effort)
  sbInsert('report_audit', {
    actor_email: actor,
    action: 'import_schwab',
    folder: 'performance',
    filename: 'schwab_transactions.csv',
    size_bytes: csvText.length,
    detail: `tx=${txInserted} cf=${cfInserted} skipped=${parsed.skipped.length} errors=${parsed.errors.length}`,
  }).catch(() => {});

  res.status(200).json({
    ok: true,
    dryRun: false,
    summary: { ...summary, txInserted, cfInserted },
    skipped: parsed.skipped,
    errors: parsed.errors,
  });
};

function dateRange(parsed) {
  const dates = [];
  for (const t of parsed.transactions) if (t.trade_date) dates.push(t.trade_date);
  for (const c of parsed.cashflows) if (c.occurred_at) dates.push(c.occurred_at);
  if (!dates.length) return null;
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

module.exports.config = {
  api: { bodyParser: false },
};
