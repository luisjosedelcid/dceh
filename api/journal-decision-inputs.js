// DCE Holdings — Decision Inputs Package API
//
// GET  /api/journal-decision-inputs?ticker=MSFT
//      Returns the latest Munger Digital v3.2 decision_inputs.json payload for
//      the ticker, if any. Used by /journal.html to prefill the v3.2 BUY modal.
//      Public read (matches /api/journal-check), only the payload is returned.
//
// POST /api/journal-decision-inputs                      (admin-only)
//      Body: { ticker, payload, source_path?, generated_at? }
//      Upserts the package. Skills (dce-decision-buy / Munger) call this so the
//      portal has fresh inputs without depending on the local sandbox path.
//
// DELETE /api/journal-decision-inputs?ticker=MSFT        (admin-only)
//      Removes the package (useful after a BUY is registered and the package
//      is no longer needed, or to force a re-run from research).

const { sbSelect, sbUpsert, sbDelete } = require('./_supabase');
const { requireCapability } = require('./_require-capability');

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function badTicker(t) {
  return !t || !TICKER_RE.test(t);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // -------- GET ----------------------------------------------------------
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
      if (badTicker(ticker)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'invalid_ticker' }));
      }
      const rows = await sbSelect(
        'decision_inputs_packages',
        `select=ticker,payload,source_path,framework_version,generated_at,uploaded_by,updated_at&ticker=eq.${encodeURIComponent(ticker)}&limit=1`
      );
      if (!rows || rows.length === 0) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, exists: false }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, exists: true, item: rows[0] }));
    }

    // -------- POST (admin) -------------------------------------------------
    if (req.method === 'POST') {
      const auth = await requireCapability(req, 'DJ-08');
      if (!auth.ok) {
        res.statusCode = auth.status || 401;
        return res.end(JSON.stringify({ ok: false, error: auth.error || 'Unauthorized' }));
      }
      const body = req.body || {};
      const ticker = (body.ticker || '').toString().toUpperCase().trim();
      if (badTicker(ticker)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'invalid_ticker' }));
      }
      let payload = body.payload;
      if (payload == null) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'payload_required' }));
      }
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); }
        catch (_) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: 'payload_not_json' }));
        }
      }
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'payload_must_be_object' }));
      }
      // Hard cap on serialized size (~256KB) to keep Postgres happy.
      try {
        const ser = JSON.stringify(payload);
        if (ser.length > 262144) {
          res.statusCode = 413;
          return res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
        }
      } catch (_) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'payload_not_serializable' }));
      }

      const row = {
        ticker,
        payload,
        source_path: body.source_path ? String(body.source_path).slice(0, 500) : null,
        framework_version: body.framework_version
          ? String(body.framework_version).slice(0, 16)
          : (payload.framework_version || 'v3.2'),
        generated_at: body.generated_at || payload.research_date || null,
        uploaded_by: auth.user.email,
        updated_at: new Date().toISOString(),
      };
      const inserted = await sbUpsert('decision_inputs_packages', row, 'ticker');
      const item = Array.isArray(inserted) ? inserted[0] : inserted;
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, item }));
    }

    // -------- DELETE (admin) -----------------------------------------------
    if (req.method === 'DELETE') {
      const auth = await requireCapability(req, 'DJ-08');
      if (!auth.ok) {
        res.statusCode = auth.status || 401;
        return res.end(JSON.stringify({ ok: false, error: auth.error || 'Unauthorized' }));
      }
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
      if (badTicker(ticker)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'invalid_ticker' }));
      }
      await sbDelete('decision_inputs_packages', `ticker=eq.${encodeURIComponent(ticker)}`);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
  } catch (e) {
    console.error('[journal-decision-inputs] error:', e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message || 'Internal error' }));
  }
};
