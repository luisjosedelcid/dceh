// Cron — daily watchlist evaluation.
// Runs at 22:50 UTC (after prices-refresh @ 22:00, before premortem-eval @ 23:00).
// For each active watchlist entry:
//   - Pull latest price from prices_daily
//   - Evaluate: price <= target_price AND mos_current >= mos_required
//   - If both true: status='triggered', triggered_at, triggered_price, triggered_mos_pct
//   - Send a single email with all newly-triggered items.
//
// Authenticated via CRON_SECRET.

'use strict';

const { sbSelect, sbUpdate } = require('../_supabase');
const { sendWatchlistTriggerAlert } = require('../_notify');

module.exports = async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.status(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    // 1. Pull all active watchlist entries
    const actives = await sbSelect('watchlist',
      'select=*&status=eq.active&order=updated_at.desc&limit=500');

    if (actives.length === 0) {
      res.status(200).end(JSON.stringify({ ok: true, evaluated: 0, triggered: 0 }));
      return;
    }

    // 2. Pull latest price per ticker (one call)
    const tickers = Array.from(new Set(actives.map(a => a.ticker)));
    const priceRows = await sbSelect('prices_daily',
      `select=ticker,close_native,price_date&ticker=in.(${tickers.join(',')})&order=price_date.desc&limit=${tickers.length * 5}`);
    const latest = {};
    for (const r of priceRows) {
      if (!latest[r.ticker]) latest[r.ticker] = r;
    }

    // 3. Evaluate each
    const triggered = [];
    const errors = [];
    for (const w of actives) {
      const p = latest[w.ticker];
      if (!p) continue;  // no price data, skip
      const price = Number(p.close_native);
      const target = Number(w.target_price);
      const anchor = Number(w.anchor_value_per_share);
      const mosReq = Number(w.mos_required_pct);
      const mosCurrent = (anchor - price) / anchor;
      const inZone = price <= target && mosCurrent >= mosReq;
      if (!inZone) continue;
      try {
        await sbUpdate('watchlist', `id=eq.${w.id}`, {
          status: 'triggered',
          triggered_at: new Date().toISOString(),
          triggered_price: price,
          triggered_mos_pct: mosCurrent,
        });
        triggered.push({
          ...w,
          triggered_price: price,
          triggered_mos_pct: mosCurrent,
        });
      } catch (e) {
        errors.push({ id: w.id, ticker: w.ticker, error: String(e.message || e).slice(0, 200) });
      }
    }

    // 4. Email if any triggered
    let emailNotice = { skipped: true, reason: 'no triggers' };
    if (triggered.length > 0) {
      emailNotice = await sendWatchlistTriggerAlert({ items: triggered });
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      evaluated: actives.length,
      triggered: triggered.length,
      tickers_triggered: triggered.map(t => t.ticker),
      email: emailNotice,
      errors: errors.length > 0 ? errors : undefined,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
