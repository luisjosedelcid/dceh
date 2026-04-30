// GET /api/source-documents?ticker=MSFT
//   Returns ingested SEC documents for a ticker (no raw_text by default).
//   Pass &include_raw=1 to include raw_text (admin only).

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
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
    const includeRaw = url.searchParams.get('include_raw') === '1' && auth.user.role === 'admin';
    if (!ticker) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'ticker required' }));
      return;
    }

    const fields = includeRaw
      ? 'id,ticker,doc_type,period_end,filed_at,source_url,source_provider,parsed_summary,raw_text,fetched_at'
      : 'id,ticker,doc_type,period_end,filed_at,source_url,source_provider,parsed_summary,fetched_at';

    const docs = await sbSelect(
      'source_documents',
      `select=${fields}&ticker=eq.${ticker}&order=period_end.desc&limit=20`
    );

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, documents: docs }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
