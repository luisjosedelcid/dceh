// POST /api/admin-ingest-docs
// Admin endpoint to ingest SEC EDGAR filings (10-K, 10-Q, 8-K) for active premortems.
// Body (optional): { ticker?: 'MSFT', limitPerForm?: 2 }

'use strict';

const { requireRole } = require('./_require-role');
const { ingestTicker, ingestAllActive } = require('./_doc-ingest');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const body = await readJsonBody(req);
    const ticker = body.ticker ? String(body.ticker).toUpperCase() : null;
    const limitPerForm = Number(body.limitPerForm || 2);
    const force = body.force === true;

    let result;
    if (ticker) {
      result = await ingestTicker(ticker, { limitPerForm, force });
    } else {
      result = await ingestAllActive({ limitPerForm, force });
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, result }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
