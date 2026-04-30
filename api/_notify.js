// Email notifications via Resend (https://resend.com).
// Required env vars:
//   RESEND_API_KEY     — your Resend API key (re_xxx)
//   ALERT_EMAIL_TO     — comma-separated recipients
//   ALERT_EMAIL_FROM   — verified sender (e.g. "DCE Reporting <reports@dceholdings.app>")
//                        If unset, falls back to "onboarding@resend.dev" (works without
//                        domain verification, but only delivers to the Resend account owner).

async function sendUploadEmail({ folder, filename, actor, sizeBytes, publicUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Reporting <onboarding@resend.dev>';

  if (!apiKey || to.length === 0) {
    return { skipped: true, reason: 'RESEND_API_KEY or ALERT_EMAIL_TO not set' };
  }

  const folderName = {
    monthly:   'Monthly Close',
    committee: 'Investment Committee',
    annual:    'Annual Report',
  }[folder] || folder;

  const sizeMb = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '—';
  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const subject = `[DCE Reporting] New ${folderName} uploaded — ${filename}`;

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Reporting Hub</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">New ${folderName} report uploaded</div>
        </td></tr>
        <tr><td style="padding:24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:1.6">
            <tr><td style="color:#606060;width:120px">Folder</td><td><strong>${escapeHtml(folderName)}</strong></td></tr>
            <tr><td style="color:#606060">Filename</td><td>${escapeHtml(filename)}</td></tr>
            <tr><td style="color:#606060">Size</td><td>${escapeHtml(sizeMb)}</td></tr>
            <tr><td style="color:#606060">Uploaded by</td><td>${escapeHtml(actor || 'Unknown')}</td></tr>
            <tr><td style="color:#606060">Timestamp</td><td>${escapeHtml(ts)} ET</td></tr>
          </table>
          <div style="margin-top:24px">
            <a href="${escapeAttr(publicUrl)}" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:0.04em">Open PDF →</a>
            <a href="https://www.dceholdings.app/reporting" style="display:inline-block;color:#1b2642;padding:10px 12px;text-decoration:none;font-size:13px;border:1px solid #1b2642;margin-left:8px">View Reporting Hub</a>
          </div>
        </td></tr>
        <tr><td style="background:#f5f5f5;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `New ${folderName} report uploaded\n\n` +
    `Filename: ${filename}\nSize: ${sizeMb}\nUploaded by: ${actor || 'Unknown'}\n` +
    `Timestamp: ${ts} ET\n\nOpen: ${publicUrl}\nReporting Hub: https://www.dceholdings.app/reporting`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

// ============================================================================
// Pre-mortem Watch alerts — sends email when failure_mode triggers fire.
// ============================================================================
async function sendPremortemAlert({ ticker, transitions, evaluatedCount }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Risk <onboarding@resend.dev>';

  if (!apiKey || to.length === 0) {
    return { skipped: true, reason: 'RESEND_API_KEY or ALERT_EMAIL_TO not set' };
  }
  if (!transitions || transitions.length === 0) {
    return { skipped: true, reason: 'No new triggers to report' };
  }

  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const tickers = Array.from(new Set(transitions.map(t => t.ticker))).join(', ');
  const subject = `[DCE Pre-mortem Watch] ⚠ ${transitions.length} new trigger${transitions.length>1?'s':''} — ${tickers}`;

  const rowsHtml = transitions.map(t => `
        <tr><td style="padding:14px 16px;border-bottom:1px solid #e6e6e6;vertical-align:top">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47;font-weight:600;margin-bottom:4px">${escapeHtml(t.ticker)} · ${escapeHtml(t.category || 'risk')}</div>
          <div style="font-size:14px;font-weight:600;color:#1b2642;margin-bottom:6px">${escapeHtml(t.failure_mode)}</div>
          <div style="font-size:12px;color:#0d0d0d;line-height:1.5;margin-bottom:6px">${escapeHtml(t.evidence)}</div>
          <div style="font-size:11px;color:#606060">Probability ${t.probability_pct ?? '—'}% · Severity ${t.severity_pct ?? '—'}%</div>
        </td></tr>`).join('');

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Pre-mortem Watch</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">⚠ New trigger${transitions.length>1?'s':''} activated</div>
        </td></tr>
        <tr><td style="padding:20px 24px;background:#fdf6e3;border-bottom:1px solid #e6e6e6">
          <div style="font-size:13px;line-height:1.6">
            <strong>${transitions.length}</strong> failure mode${transitions.length>1?'s':''} on <strong>${escapeHtml(tickers)}</strong> just transitioned from <em>monitoring</em> to <em>triggered</em>.
            <br><span style="color:#606060;font-size:11px">Evaluated ${evaluatedCount} active triggers · ${escapeHtml(ts)} ET</span>
          </div>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${rowsHtml}
          </table>
        </td></tr>
        <tr><td style="padding:20px 24px;border-top:1px solid #e6e6e6">
          <a href="https://www.dceholdings.app/premortem" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:0.04em">Open Pre-mortem Watch →</a>
          <a href="https://www.dceholdings.app/performance" style="display:inline-block;color:#1b2642;padding:10px 12px;text-decoration:none;font-size:13px;border:1px solid #1b2642;margin-left:8px">Performance Dashboard</a>
        </td></tr>
        <tr><td style="background:#f5f5f5;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textLines = [
    `DCE Pre-mortem Watch — ${transitions.length} new trigger(s) on ${tickers}`,
    '',
    ...transitions.map(t => `• [${t.ticker}] ${t.failure_mode}\n  ${t.evidence}\n  P=${t.probability_pct ?? '—'}% / S=${t.severity_pct ?? '—'}%`),
    '',
    `Evaluated ${evaluatedCount} active triggers · ${ts} ET`,
    `Open: https://www.dceholdings.app/premortem`,
  ];

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text: textLines.join('\n') }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ============================================================================
// Re-underwriting due alerts — sends email when new 10-Q/10-K creates pending review.
// ============================================================================
async function sendReunderwritingDueAlert({ items }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Re-underwriting <onboarding@resend.dev>';

  if (!apiKey || to.length === 0) {
    return { skipped: true, reason: 'RESEND_API_KEY or ALERT_EMAIL_TO not set' };
  }
  if (!items || items.length === 0) {
    return { skipped: true, reason: 'No new dues to report' };
  }

  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const tickers = Array.from(new Set(items.map(t => t.ticker))).join(', ');
  const subject = `[DCE Re-underwriting] ${items.length} new review${items.length>1?'s':''} pending — ${tickers}`;

  const rowsHtml = items.map(it => `
        <tr><td style="padding:14px 16px;border-bottom:1px solid #e6e6e6;vertical-align:top">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47;font-weight:600;margin-bottom:4px">${escapeHtml(it.ticker)} · ${escapeHtml(it.doc_type)}</div>
          <div style="font-size:14px;font-weight:600;color:#1b2642;margin-bottom:6px">Period ending ${escapeHtml(it.period_end)}</div>
          <div style="font-size:12px;color:#606060">Re-underwriting required — review thesis, kill criteria and decide action.</div>
        </td></tr>`).join('');

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Re-underwriting</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">${items.length} new review${items.length>1?'s':''} pending</div>
        </td></tr>
        <tr><td style="padding:20px 24px;background:#fdf6e3;border-bottom:1px solid #e6e6e6">
          <div style="font-size:13px;line-height:1.6">
            <strong>${items.length}</strong> new 10-Q/10-K filing${items.length>1?'s':''} on <strong>${escapeHtml(tickers)}</strong> require${items.length>1?'':'s'} a re-underwriting review.
            <br><span style="color:#606060;font-size:11px">${escapeHtml(ts)} ET</span>
          </div>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${rowsHtml}
          </table>
        </td></tr>
        <tr><td style="padding:20px 24px;border-top:1px solid #e6e6e6">
          <a href="https://www.dceholdings.app/journal" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold;letter-spacing:0.04em">Open Decision Journal →</a>
        </td></tr>
        <tr><td style="background:#f5f5f5;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textLines = [
    `DCE Re-underwriting — ${items.length} new review(s) pending on ${tickers}`,
    '',
    ...items.map(it => `• [${it.ticker}] ${it.doc_type} · period ${it.period_end}`),
    '',
    `${ts} ET`,
    `Open: https://www.dceholdings.app/journal`,
  ];

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text: textLines.join('\n') }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

module.exports = { sendUploadEmail, sendPremortemAlert, sendReunderwritingDueAlert };
