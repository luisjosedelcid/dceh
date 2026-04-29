// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Price Alerts cron
// GET /api/cron/price-alerts
//   - Loads active price_alerts (triggered_at IS NULL, active=true)
//   - Fetches live prices via Finnhub for each unique ticker
//   - For each alert:
//       floor:    triggers if live <= threshold
//       ceiling:  triggers if live >= threshold
//   - Sends ONE consolidated email with all triggers (if any)
//   - Marks each triggered alert: triggered_at = now(), active = false,
//     triggered_price = live, last_email_sent_at = now()
//
// Triggered by Vercel cron (see vercel.json crons).
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbUpdate } = require('../_supabase.js');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchPrice(ticker, fhKey) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${fhKey}`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const p = Number(d && d.c);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function sendAlertEmail(triggers) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Reporting <onboarding@resend.dev>';
  if (!apiKey || to.length === 0) return { skipped: true, reason: 'missing email config' };

  const rows = triggers.map(t => {
    const arrow = t.alert_type === 'floor' ? '↓' : '↑';
    const dirLabel = t.alert_type === 'floor' ? 'BELOW FLOOR' : 'ABOVE CEILING';
    const color = t.alert_type === 'floor' ? '#9b2335' : '#2a7a56';
    return `
    <tr style="border-bottom:1px solid #e6e6e6">
      <td style="padding:10px 12px;font-weight:bold;color:#1b2642;font-size:14px">${escapeHtml(t.ticker)}</td>
      <td style="padding:10px 12px;color:${color};font-weight:bold;font-size:11px;letter-spacing:0.08em">${arrow} ${dirLabel}</td>
      <td style="padding:10px 12px;color:#1b2642">$${fmtMoney(t.threshold)}</td>
      <td style="padding:10px 12px;color:#1b2642;font-weight:bold">$${fmtMoney(t.live_price)}</td>
      <td style="padding:10px 12px;color:#606060;font-size:11px;text-transform:uppercase;letter-spacing:0.06em">${escapeHtml(t.scope)}</td>
    </tr>`;
  }).join('');

  const subject = `🔔 [DCE] ${triggers.length} price alert${triggers.length === 1 ? '' : 's'} triggered`;
  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f1eb;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1eb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff;border-bottom:2px solid #b88b47">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Price Alerts</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">${triggers.length} alert${triggers.length === 1 ? '' : 's'} triggered</div>
        </td></tr>
        <tr><td style="padding:20px 24px">
          <p style="font-size:13px;color:#606060;margin:0 0 14px">The following price alerts crossed their threshold. Each alert has been disarmed; re-arm from Universe / Portfolio if you want to keep watching.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
            <thead><tr style="background:#1b2642;color:#ffffff">
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">TICKER</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">DIRECTION</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">THRESHOLD</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">CURRENT</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">SCOPE</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:22px">
            <a href="https://www.dceholdings.app/portfolio.html" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold">Portfolio →</a>
            <a href="https://www.dceholdings.app/universe.html" style="display:inline-block;color:#1b2642;padding:10px 12px;text-decoration:none;font-size:13px;border:1px solid #1b2642;margin-left:8px">Covered Universe</a>
          </div>
        </td></tr>
        <tr><td style="background:#f5f1eb;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${triggers.length} price alert(s) triggered:\n\n` +
    triggers.map(t => `${t.ticker} · ${t.alert_type === 'floor' ? '↓ below' : '↑ above'} $${fmtMoney(t.threshold)} (current $${fmtMoney(t.live_price)})`).join('\n') +
    `\n\nView: https://www.dceholdings.app/portfolio.html`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

module.exports = async (req, res) => {
  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const fhKey = process.env.FINNHUB_API_KEY || 'd6pi2h1r01qo88ajadq0d6pi2h1r01qo88ajadqg';

  try {
    const alerts = await sbSelect('price_alerts',
      'select=id,ticker,alert_type,threshold,scope&active=eq.true&triggered_at=is.null&limit=500');

    if (alerts.length === 0) {
      res.status(200).json({ ok: true, checked: 0, triggered: 0 });
      return;
    }

    // Fetch unique tickers in parallel
    const uniqueTickers = [...new Set(alerts.map(a => a.ticker))];
    const priceEntries = await Promise.all(
      uniqueTickers.map(async t => [t, await fetchPrice(t, fhKey)])
    );
    const prices = Object.fromEntries(priceEntries);

    const triggers = [];
    for (const a of alerts) {
      const live = prices[a.ticker];
      if (live == null) continue; // can't fetch (e.g. SAP XETRA on free tier)
      const th = Number(a.threshold);
      const fired = a.alert_type === 'floor' ? live <= th : live >= th;
      if (!fired) continue;

      // Mark fired
      await sbUpdate('price_alerts', `id=eq.${a.id}`, {
        triggered_at: new Date().toISOString(),
        triggered_price: live,
        active: false,
        last_email_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      triggers.push({ ...a, live_price: live });
    }

    let email = null;
    if (triggers.length > 0) {
      email = await sendAlertEmail(triggers);
    }

    res.status(200).json({
      ok: true,
      checked: alerts.length,
      tickers_priced: Object.values(prices).filter(p => p != null).length,
      triggered: triggers.length,
      triggers: triggers.map(t => ({ ticker: t.ticker, type: t.alert_type, threshold: t.threshold, live: t.live_price })),
      email,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
