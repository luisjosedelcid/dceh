// POST /api/admin-premortem-eval
// Admin-only endpoint to manually trigger pre-mortem evaluation.
// Body (optional): { ticker?: 'MSFT', dryRun?: boolean, sendEmail?: boolean (default true) }
// Sends email via Resend when failure modes transition to triggered.

'use strict';

const { requireRole } = require('./_require-role');
const { evaluateAll } = require('./_premortem-eval');
const { sendPremortemAlert } = require('./_notify');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const body = await readJsonBody(req);
    const ticker = body.ticker ? String(body.ticker).toUpperCase() : null;
    const dryRun = body.dryRun === true;
    const sendEmail = body.sendEmail !== false;

    const result = await evaluateAll({ ticker, dryRun });

    let emailResult = { skipped: true, reason: 'sendEmail=false or no transitions' };
    if (sendEmail && result.transitions && result.transitions.length > 0 && !dryRun) {
      // Group by ticker for the alert (we may have multiple)
      const tickers = Array.from(new Set(result.transitions.map(t => t.ticker))).join(',');
      emailResult = await sendPremortemAlert({
        ticker: tickers,
        transitions: result.transitions,
        evaluatedCount: result.evaluated,
      });
    }

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      evaluated: result.evaluated,
      transitions: result.transitions,
      details: result.details,
      email: emailResult,
      dryRun,
    }));
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
