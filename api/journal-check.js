// DCE Holdings — Decision Journal lookup API
// GET /api/journal-check?ticker=BKNG
//
// Returns the most recent active decision_journal entry for a ticker, if any.
// Used by the company dashboard Summary tab to decide whether the CIO action
// button should say "Open Decision Journal" (no entry yet) or
// "View Decision: BUY/PASS" (entry already exists).
//
// Response:
//   { ok: true, exists: false }
//   { ok: true, exists: true, item: { id, ticker, decision_type, decision_date } }
//
// Public read (no admin token needed). Only returns minimal fields.

const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tickerRaw = (url.searchParams.get('ticker') || '').trim().toUpperCase();
    if (!tickerRaw || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(tickerRaw)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_ticker' }));
    }

    // Most recent active entry for this ticker
    const rows = await sbSelect(
      'decision_journal',
      `select=id,ticker,decision_type,decision_date&ticker=eq.${encodeURIComponent(tickerRaw)}&active=eq.true&order=decision_date.desc,id.desc&limit=1`
    );

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    if (!rows || rows.length === 0) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, exists: false }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, exists: true, item: rows[0] }));
  } catch (err) {
    console.error('[journal-check]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'internal_error', detail: String(err && err.message || err) }));
  }
};
