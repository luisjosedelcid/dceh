// Cron — daily pre-mortem trigger evaluation. Runs at 23:00 UTC after
// prices-refresh (22:00 UTC) and portfolio-snapshot (22:30 UTC).
// Authenticated via CRON_SECRET. Sends email on transitions.

'use strict';

const { evaluateAll } = require('../_premortem-eval');
const { sendPremortemAlert } = require('../_notify');

module.exports = async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.status(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const result = await evaluateAll({ ticker: null, dryRun: false });

    let emailResult = { skipped: true, reason: 'No transitions' };
    if (result.transitions && result.transitions.length > 0) {
      const tickers = Array.from(new Set(result.transitions.map(t => t.ticker))).join(',');
      emailResult = await sendPremortemAlert({
        ticker: tickers,
        transitions: result.transitions,
        evaluatedCount: result.evaluated,
      });
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      evaluated: result.evaluated,
      new_triggers: result.transitions.length,
      email: emailResult,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
