// Cron — daily pre-mortem trigger evaluation. Runs at 23:00 UTC after
// prices-refresh (22:00 UTC) and portfolio-snapshot (22:30 UTC).
// Authenticated via CRON_SECRET. Sends email on transitions.

'use strict';

const { evaluateAll } = require('../_premortem-eval');
const { sendPremortemAlert } = require('../_notify');
const { sendPushBroadcast } = require('../_push');

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
    let pushResult = { skipped: true, reason: 'No transitions' };
    if (result.transitions && result.transitions.length > 0) {
      const tickers = Array.from(new Set(result.transitions.map(t => t.ticker)));
      const tickerStr = tickers.join(',');
      emailResult = await sendPremortemAlert({
        ticker: tickerStr,
        transitions: result.transitions,
        evaluatedCount: result.evaluated,
      });

      // Push (best-effort; do not fail cron on push error)
      try {
        const n = result.transitions.length;
        const title = tickers.length === 1
          ? `${tickers[0]} — thesis-breaker triggered`
          : `${n} thesis-breakers triggered (${tickers.length} tickers)`;
        const preview = result.transitions.slice(0, 3).map(t => {
          const dir = t.direction ? ` ${t.direction}` : '';
          return `${t.ticker}: ${t.trigger_label || t.trigger_id || 'trigger'}${dir}`;
        }).join(' · ');
        pushResult = await sendPushBroadcast({
          title,
          body: preview.slice(0, 380),
          url: tickers.length === 1 ? `/premortem.html?ticker=${encodeURIComponent(tickers[0])}` : '/premortem.html',
          tag: 'premortem-alerts',
          data: { kind: 'premortem_alert', count: n, tickers },
        });
      } catch (e) {
        pushResult = { ok: false, error: String(e).slice(0, 200) };
      }
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      evaluated: result.evaluated,
      new_triggers: result.transitions.length,
      email: emailResult,
      push: pushResult,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
