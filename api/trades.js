// DCE Holdings — Trade Execution Log
//
// GET  /api/trades?decision_id=123       (public read, returns trades for a decision)
// GET  /api/trades?ticker=LULU            (public read, all trades for a ticker)
// POST /api/trades                        (admin only — log a new execution)
// DELETE /api/trades?id=N                 (admin only — undo a logged trade)
//
// Body for POST:
//   {
//     decision_id, ticker, trade_type ('BUY'|'ADD'|'TRIM'|'SELL'),
//     trade_date (YYYY-MM-DD), shares, price,
//     fees?, broker?, notes?
//   }
//
// Trades are linked to decision_journal entries. Portfolio reconstruction lives
// elsewhere (broker CSV ingest); this table is the audit trail of "what did we
// actually execute against each documented committee decision".

const { sbSelect, sbInsert, sbDelete } = require('./_supabase');
const { requireRole } = require('./_require-role');

const ALLOWED_TYPES = ['BUY', 'ADD', 'TRIM', 'SELL'];

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return handleGet(req, res);
    }
    if (req.method === 'POST') {
      const auth = await requireRole(req, ['admin']);
      if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
      return handlePost(req, res, auth.user);
    }
    if (req.method === 'DELETE') {
      const auth = await requireRole(req, ['admin']);
      if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
      return handleDelete(req, res);
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/trades] error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

async function handleGet(req, res) {
  const decisionId = parseInt(req.query.decision_id || '', 10);
  const ticker = (req.query.ticker || '').toString().toUpperCase().trim();

  let q = 'select=*&order=trade_date.desc,id.desc&limit=500';
  if (Number.isFinite(decisionId) && decisionId > 0) {
    q += `&decision_id=eq.${decisionId}`;
  } else if (ticker) {
    q += `&ticker=eq.${encodeURIComponent(ticker)}`;
  }

  const items = await sbSelect('trades', q);
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  return res.status(200).json({ ok: true, items });
}

async function handlePost(req, res, user) {
  const body = req.body || {};
  const errors = [];

  const decisionId = parseInt(body.decision_id, 10);
  if (!Number.isFinite(decisionId) || decisionId <= 0) errors.push('decision_id required');

  const ticker = String(body.ticker || '').toUpperCase().trim();
  if (!ticker) errors.push('ticker required');

  const tradeType = String(body.trade_type || '').toUpperCase().trim();
  if (!ALLOWED_TYPES.includes(tradeType)) errors.push(`trade_type must be one of ${ALLOWED_TYPES.join(', ')}`);

  const tradeDate = String(body.trade_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) errors.push('trade_date must be YYYY-MM-DD');

  const shares = Number(body.shares);
  if (!Number.isFinite(shares) || shares <= 0) errors.push('shares must be positive number');

  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) errors.push('price must be non-negative number');

  const fees = body.fees == null || body.fees === '' ? 0 : Number(body.fees);
  if (!Number.isFinite(fees) || fees < 0) errors.push('fees must be non-negative number');

  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }

  // Sanity check: decision exists & ticker matches
  const dec = await sbSelect('decision_journal', `select=id,ticker,decision_type&id=eq.${decisionId}&limit=1`);
  if (!dec.length) {
    return res.status(404).json({ ok: false, error: `decision_journal id=${decisionId} not found` });
  }
  if (dec[0].ticker !== ticker) {
    return res.status(400).json({ ok: false, error: `ticker mismatch: decision is ${dec[0].ticker}, trade says ${ticker}` });
  }

  const row = {
    decision_id: decisionId,
    ticker,
    trade_type: tradeType,
    trade_date: tradeDate,
    shares,
    price,
    fees,
    broker: body.broker ? String(body.broker).trim() : null,
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: user?.email || null,
  };

  const inserted = await sbInsert('trades', row);
  return res.status(200).json({ ok: true, trade: inserted[0] || inserted });
}

async function handleDelete(req, res) {
  const id = parseInt(req.query.id || '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'id required' });
  }
  await sbDelete('trades', `id=eq.${id}`);
  return res.status(200).json({ ok: true });
}
