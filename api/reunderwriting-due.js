// GET /api/reunderwriting-due
//   Returns pending re-underwriting items (and recently completed ones for context).
//   Query params:
//     ?status=pending|done|skipped   (default: pending)
//     ?ticker=MSFT                   (optional filter)
//     ?limit=50                      (default 50)
//
// Each item includes: ticker, period_end, doc_type, source_url (joined),
// last entry context (price, days since filing).
//
// Auth: any active user can read.

'use strict';

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const status = url.searchParams.get('status') || 'pending';
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);

    // Pull dues + join source_documents for source_url
    let q = `select=id,ticker,period_end,doc_type,source_doc_id,status,due_at,completed_at,entry_id,notes,source_documents(source_url,filed_at,parsed_summary)&order=due_at.desc&limit=${limit}`;
    if (status && status !== 'all') q += `&status=eq.${status}`;
    if (ticker) q += `&ticker=eq.${ticker}`;

    const dues = await sbSelect('reunderwriting_due', q);

    // Flatten the join + add days_since_filing
    const today = new Date();
    const items = dues.map(d => {
      const sd = d.source_documents || {};
      const filed = sd.filed_at ? new Date(sd.filed_at) : null;
      const daysSince = filed ? Math.floor((today - filed) / (1000 * 60 * 60 * 24)) : null;
      return {
        id: d.id,
        ticker: d.ticker,
        period_end: d.period_end,
        doc_type: d.doc_type,
        source_doc_id: d.source_doc_id,
        source_url: sd.source_url || null,
        filed_at: sd.filed_at || null,
        days_since_filing: daysSince,
        status: d.status,
        due_at: d.due_at,
        completed_at: d.completed_at,
        entry_id: d.entry_id,
        notes: d.notes,
      };
    });

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, items }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
