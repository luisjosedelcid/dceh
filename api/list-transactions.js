// GET /api/list-transactions?limit=50
// Returns recent transactions and cashflows for the performance UI.
// Admin or analyst can read.

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);

  try {
    const [transactions, cashflows] = await Promise.all([
      sbSelect('transactions', `select=*&order=trade_date.desc,id.desc&limit=${limit}`),
      sbSelect('cashflows', `select=*&order=occurred_at.desc,id.desc&limit=${limit}`),
    ]);
    res.status(200).json({ ok: true, transactions, cashflows });
  } catch (e) {
    res.status(500).json({ error: 'Query failed', detail: String(e).slice(0, 300) });
  }
};
