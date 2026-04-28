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

module.exports = { sendUploadEmail };
