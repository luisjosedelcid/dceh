// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Pre-Reminder cron
// GET /api/cron/earnings-alerts
//
// Sends one consolidated email when there are earnings events scheduled
// to occur in the next 24-48 hours that haven't been reminded yet.
// Idempotency via earnings_alerts_sent (PK ticker+date).
//
// Triggered by Vercel cron (see vercel.json) — recommended daily at 08:00 UTC.
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbInsert } = require('../_supabase.js');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function sendAlertEmail(events) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Reporting <onboarding@resend.dev>';
  if (!apiKey || to.length === 0) return { skipped: true, reason: 'missing email config' };

  const rows = events.map(e => {
    const timingTag = e.timing === 'BMO'
      ? '<span style="background:rgba(42,122,86,0.12);color:#2a7a56;padding:3px 8px;font-size:9px;letter-spacing:0.1em;font-weight:700">BMO</span>'
      : e.timing === 'AMC'
      ? '<span style="background:rgba(184,139,71,0.14);color:#b88b47;padding:3px 8px;font-size:9px;letter-spacing:0.1em;font-weight:700">AMC</span>'
      : '<span style="background:rgba(27,38,66,0.06);color:#606060;padding:3px 8px;font-size:9px;letter-spacing:0.1em;font-weight:700">TBD</span>';
    const eps = e.eps_estimate != null ? `EPS est. $${Number(e.eps_estimate).toFixed(2)}` : 'No estimate';
    return `
    <tr style="border-bottom:1px solid #e6e6e6">
      <td style="padding:12px 14px;font-weight:bold;color:#1b2642;font-size:14px;width:80px">${escapeHtml(e.ticker)}</td>
      <td style="padding:12px 14px;color:#1b2642">${escapeHtml(e.company || e.ticker)}</td>
      <td style="padding:12px 14px;color:#606060;font-size:11px">${escapeHtml(e.date)}</td>
      <td style="padding:12px 14px">${timingTag}</td>
      <td style="padding:12px 14px;color:#606060;font-size:11px">${escapeHtml(eps)}</td>
    </tr>`;
  }).join('');

  const subject = `[DCE] ${events.length} earnings event${events.length === 1 ? '' : 's'} in the next 48h`;
  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f1eb;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1eb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff;border-bottom:2px solid #b88b47">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Earnings Calendar</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">${events.length} report${events.length === 1 ? '' : 's'} due in the next 48 hours</div>
        </td></tr>
        <tr><td style="padding:20px 24px">
          <p style="font-size:13px;color:#606060;margin:0 0 14px">Heads-up on upcoming earnings for tickers in the DCE universe, portfolio and watchlist.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
            <thead><tr style="background:#1b2642;color:#ffffff">
              <th style="padding:10px 14px;text-align:left;font-size:10px;letter-spacing:0.1em">TICKER</th>
              <th style="padding:10px 14px;text-align:left;font-size:10px;letter-spacing:0.1em">COMPANY</th>
              <th style="padding:10px 14px;text-align:left;font-size:10px;letter-spacing:0.1em">DATE</th>
              <th style="padding:10px 14px;text-align:left;font-size:10px;letter-spacing:0.1em">TIMING</th>
              <th style="padding:10px 14px;text-align:left;font-size:10px;letter-spacing:0.1em">CONSENSUS</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:22px">
            <a href="https://www.dceholdings.app/calendar.html" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold">Calendar →</a>
          </div>
        </td></tr>
        <tr><td style="background:#f5f1eb;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${events.length} earnings event(s) in the next 48h:\n\n` +
    events.map(e => `${e.ticker} — ${e.company || e.ticker} — ${e.date} ${e.timing || ''}`).join('\n') +
    `\n\nView: https://www.dceholdings.app/calendar.html`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data };
    return { ok: true, id: data.id, recipients: to.join(',') };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const today = new Date();
    const in48h = new Date(today.getTime() + 48 * 3600 * 1000);
    const fromIso = isoDate(today);
    const toIso = isoDate(in48h);

    // Earnings due in next 48h, status upcoming
    const events = await sbSelect(
      'earnings_calendar',
      `select=ticker,date,company,timing,eps_estimate,ir_url&status=eq.upcoming&date=gte.${fromIso}&date=lte.${toIso}&order=date.asc`
    );

    if (!events.length) {
      res.status(200).json({ ok: true, found: 0, sent: 0 });
      return;
    }

    // Filter out already-sent (idempotency)
    const sent = await sbSelect('earnings_alerts_sent', `select=ticker,date&date=gte.${fromIso}&date=lte.${toIso}`);
    const sentSet = new Set(sent.map(s => `${s.ticker}|${s.date}`));
    const fresh = events.filter(e => !sentSet.has(`${e.ticker}|${e.date}`));

    if (!fresh.length) {
      res.status(200).json({ ok: true, found: events.length, sent: 0, reason: 'all already alerted' });
      return;
    }

    const email = await sendAlertEmail(fresh);

    // Mark as sent only on successful send
    if (email && email.ok) {
      for (const ev of fresh) {
        try {
          await sbInsert('earnings_alerts_sent', {
            ticker: ev.ticker,
            date: ev.date,
            email_id: email.id || null,
            recipients: email.recipients || null,
          });
        } catch {} // PK conflict means another invocation already wrote it
      }
    }

    res.status(200).json({
      ok: true,
      found: events.length,
      fresh: fresh.length,
      sent: email && email.ok ? fresh.length : 0,
      email,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
