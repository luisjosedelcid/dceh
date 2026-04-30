// POST /api/admin-add-manual-entry
// Body: { kind, date, ticker, qty, amount, notes }
//   kind ∈ BUY | SELL | DIVIDEND | INTEREST | FEE | TAX | CONTRIBUTION | WITHDRAWAL
//
// Routes BUY/SELL to `transactions`, everything else to `cashflows`.
// Source = 'manual', external_id = sha hash so re-submitting same entry is no-op.

const crypto = require('crypto');
const { requireRole } = require('./_require-role');
const { sbInsert } = require('./_supabase');

const TX_KINDS = new Set(['BUY', 'SELL']);
const CF_KINDS = new Set(['DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'CONTRIBUTION', 'WITHDRAWAL', 'FX_GAIN']);

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

  // Body parsing (Vercel default JSON parser is on for this route)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const kind = String(body.kind || '').toUpperCase().trim();
  const date = String(body.date || '').trim();
  const ticker = String(body.ticker || '').toUpperCase().trim() || null;
  const qty = Number(body.qty || 0);
  const amount = Number(body.amount || 0);
  const notes = String(body.notes || '').trim() || null;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Valid YYYY-MM-DD date required' });
    return;
  }
  if (!amount || isNaN(amount)) {
    res.status(400).json({ error: 'Numeric amount required' });
    return;
  }

  if (TX_KINDS.has(kind)) {
    if (!ticker) { res.status(400).json({ error: 'Ticker required for BUY/SELL' }); return; }
    if (!qty || qty <= 0) { res.status(400).json({ error: 'Positive qty required for BUY/SELL' }); return; }

    const price = Math.abs(amount) / qty;
    const fingerprint = crypto.createHash('sha256')
      .update(['manual', kind, date, ticker, qty, amount].join('|'))
      .digest('hex').slice(0, 24);

    try {
      const row = {
        ticker,
        side: kind,
        qty,
        price_native: price,
        currency: 'USD',
        fx_to_usd: 1,
        fee_native: 0,
        trade_date: date,
        settle_date: date,
        source: 'manual',
        external_id: fingerprint,
        notes,
      };
      const out = await sbInsert('transactions', row);
      res.status(200).json({ ok: true, kind, inserted: out });
      return;
    } catch (e) {
      // If duplicate (unique violation), swallow
      if (String(e).includes('duplicate')) {
        res.status(200).json({ ok: true, kind, duplicate: true });
        return;
      }
      res.status(500).json({ error: 'Insert failed', detail: String(e).slice(0, 300) });
      return;
    }
  }

  if (CF_KINDS.has(kind)) {
    // Sign convention:
    //   CONTRIBUTION, DIVIDEND, INTEREST, FX_GAIN → positive
    //   WITHDRAWAL, FEE, TAX → negative
    const POS = new Set(['CONTRIBUTION', 'DIVIDEND', 'INTEREST', 'FX_GAIN']);
    const signed = POS.has(kind) ? Math.abs(amount) : -Math.abs(amount);

    const fingerprint = crypto.createHash('sha256')
      .update(['manual', kind, date, ticker || '', amount].join('|'))
      .digest('hex').slice(0, 24);

    try {
      const row = {
        cf_type: kind,
        ticker,
        amount_native: signed,
        currency: 'USD',
        fx_to_usd: 1,
        occurred_at: date,
        source: 'manual',
        external_id: fingerprint,
        notes,
      };
      const out = await sbInsert('cashflows', row);
      res.status(200).json({ ok: true, kind, inserted: out });
      return;
    } catch (e) {
      if (String(e).includes('duplicate')) {
        res.status(200).json({ ok: true, kind, duplicate: true });
        return;
      }
      res.status(500).json({ error: 'Insert failed', detail: String(e).slice(0, 300) });
      return;
    }
  }

  res.status(400).json({ error: `Unknown kind '${kind}'` });
};
