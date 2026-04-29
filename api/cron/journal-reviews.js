// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Decision Journal review reminders cron
// GET /api/cron/journal-reviews
//   - Finds decision_journal entries with reviews due (3m/6m/12m)
//     where the review date is <= today and review_*_done_at is null
//   - Sends a single daily email summarising all pending reviews
//   - Skips if no pending reviews (silent)
//
// Triggered by Vercel cron daily (see vercel.json crons).
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('../_supabase.js');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00Z' : d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function sendReviewEmail(pending) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Reporting <onboarding@resend.dev>';
  if (!apiKey || to.length === 0) return { skipped: true, reason: 'missing email config' };

  const rows = pending.map(p => `
    <tr style="border-bottom:1px solid #e6e6e6">
      <td style="padding:10px 12px;font-weight:bold;color:#1b2642">${escapeHtml(p.ticker)}</td>
      <td style="padding:10px 12px;color:#1b2642">${escapeHtml(p.decision_type)}</td>
      <td style="padding:10px 12px">${escapeHtml(p.review_label)}</td>
      <td style="padding:10px 12px;color:#606060">${escapeHtml(fmtDate(p.review_date))}</td>
      <td style="padding:10px 12px;color:#606060;font-size:11px">${escapeHtml((p.thesis || '').slice(0, 90))}…</td>
    </tr>`).join('');

  const subject = `[DCE] ${pending.length} decision review${pending.length === 1 ? '' : 's'} due`;
  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f1eb;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1eb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1b2642;padding:18px 24px;color:#ffffff;border-bottom:2px solid #b88b47">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b88b47">DCE Holdings · Decision Journal</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">${pending.length} review${pending.length === 1 ? '' : 's'} due</div>
        </td></tr>
        <tr><td style="padding:20px 24px">
          <p style="font-size:13px;color:#606060;margin:0 0 14px">The following decisions are due for revisit. Reflect on whether the thesis is playing out, the catalysts triggered, or if conviction has changed.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
            <thead><tr style="background:#1b2642;color:#ffffff">
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">TICKER</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">TYPE</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">REVIEW</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">DUE</th>
              <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.1em">THESIS</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:22px">
            <a href="https://www.dceholdings.app/reporting" style="display:inline-block;background:#1b2642;color:#ffffff;padding:10px 20px;text-decoration:none;font-size:13px;font-weight:bold">Mark reviews →</a>
            <a href="https://www.dceholdings.app/journal.html" style="display:inline-block;color:#1b2642;padding:10px 12px;text-decoration:none;font-size:13px;border:1px solid #1b2642;margin-left:8px">View Journal</a>
          </div>
        </td></tr>
        <tr><td style="background:#f5f1eb;border-top:2px solid #b88b47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential · Internal use only
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${pending.length} decision review(s) due:\n\n` +
    pending.map(p => `${p.ticker} · ${p.decision_type} · ${p.review_label} (due ${fmtDate(p.review_date)})`).join('\n') +
    `\n\nMark reviews: https://www.dceholdings.app/reporting`;

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

  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await sbSelect('decision_journal',
      'select=id,ticker,decision_type,thesis,review_3m_date,review_6m_date,review_12m_date,review_3m_done_at,review_6m_done_at,review_12m_done_at&active=eq.true&limit=2000');

    const pending = [];
    for (const r of rows) {
      [['3-month', 'review_3m'], ['6-month', 'review_6m'], ['12-month', 'review_12m']].forEach(([label, key]) => {
        const date = r[key + '_date'];
        const done = r[key + '_done_at'];
        if (date && date <= today && !done) {
          pending.push({
            ticker: r.ticker,
            decision_type: r.decision_type,
            thesis: r.thesis,
            review_label: label,
            review_date: date,
          });
        }
      });
    }

    if (pending.length === 0) {
      res.status(200).json({ ok: true, pending: 0, sent: false });
      return;
    }

    const result = await sendReviewEmail(pending);
    res.status(200).json({ ok: true, pending: pending.length, email: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
