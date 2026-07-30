// POST /api/auth/forgot-password
// Body: { email: string }
// Response: always { ok: true } (no user enumeration)
//
// - Looks up email in admin_users; if it exists AND is_active, generates a
//   32-byte random token, stores its SHA-256 hash in password_reset_tokens
//   with 60-min expiry, and emails the user a link:
//     https://<host>/reset?token=<raw_token>
// - If the email doesn't exist or user is inactive, silently succeeds.
// - Rate limits: max 3 requests per email per hour.

const crypto = require('crypto');
const { sbSelect, sbInsert } = require('../_supabase');

const TOKEN_TTL_MIN = 60;
const RATE_WINDOW_MIN = 60;
const RATE_MAX_PER_EMAIL = 3;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

async function sendResetEmail({ toEmail, resetUrl, displayName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM || 'DCE Holdings <onboarding@resend.dev>';

  if (!apiKey) {
    return { skipped: true, reason: 'RESEND_API_KEY not set' };
  }

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e6e6">
        <tr><td style="background:#1B2642;padding:18px 24px;color:#ffffff">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#B88B47">DCE Holdings</div>
          <div style="font-size:18px;font-weight:bold;margin-top:4px">Restablecer contraseña</div>
        </td></tr>
        <tr><td style="padding:28px 24px;font-size:14px;line-height:1.6">
          <p style="margin:0 0 16px 0">Hola${displayName ? ' ' + displayName.split(/\\s+/)[0] : ''},</p>
          <p style="margin:0 0 16px 0">Recibimos una solicitud para restablecer la contraseña de tu cuenta en <strong>dceholdings.app</strong>. Hacé clic en el botón para elegir una nueva contraseña:</p>
          <div style="margin:24px 0">
            <a href="${resetUrl}" style="display:inline-block;background:#1B2642;color:#ffffff;padding:12px 28px;text-decoration:none;font-size:14px;font-weight:bold;letter-spacing:0.04em;border-radius:4px">Restablecer contraseña →</a>
          </div>
          <p style="margin:0 0 12px 0;font-size:13px;color:#606060">
            El link vence en 60 minutos y solo puede usarse una vez.
          </p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#606060">
            Si vos no solicitaste este cambio, ignorá este correo — tu contraseña no cambia hasta que abras el link y elijas una nueva.
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#606060;word-break:break-all">
            Si el botón no funciona, copiá este link en el navegador:<br>
            <span style="color:#1B2642">${resetUrl}</span>
          </p>
        </td></tr>
        <tr><td style="background:#f5f5f5;border-top:2px solid #B88B47;padding:14px 24px;font-size:11px;color:#606060">
          DCE Holdings — Investment Office · Confidential
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: 'Restablecer tu contraseña — DCE Holdings',
      html,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[forgot-password] Resend ${res.status} — from=${from} to=${toEmail} body=${t.slice(0, 400)}`);
    return { ok: false, error: `Resend ${res.status}: ${t.slice(0, 200)}` };
  }
  const respJson = await res.json().catch(() => ({}));
  console.log(`[forgot-password] Resend OK — from=${from} to=${toEmail} id=${respJson.id || 'unknown'}`);
  return { ok: true };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Email inválido' }));
      return;
    }

    // Rate limit: max 3 tokens per email in the last hour
    const sinceIso = new Date(Date.now() - RATE_WINDOW_MIN * 60 * 1000).toISOString();
    const recent = await sbSelect(
      'password_reset_tokens',
      `select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(sinceIso)}&limit=10`
    );
    if (recent.length >= RATE_MAX_PER_EMAIL) {
      // Silently succeed to avoid user enumeration + prevent abuse
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Look up user
    const users = await sbSelect(
      'admin_users',
      `select=email,display_name,is_active&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    const user = users[0];

    // If user exists and is active, generate token + send email
    if (user && user.is_active) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256(rawToken);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000).toISOString();

      await sbInsert('password_reset_tokens', {
        email,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_ip: getClientIp(req).slice(0, 64),
      });

      const host = (req.headers['x-forwarded-host'] || req.headers.host || 'dceholdings.app').toString();
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
      const resetUrl = `${proto}://${host}/reset?token=${rawToken}`;

      // Await email send so we can log real errors, then continue.
      // We still return ok:true regardless to prevent enumeration.
      const emailResult = await sendResetEmail({
        toEmail: email,
        resetUrl,
        displayName: user.display_name,
      }).catch(e => ({ ok: false, error: String(e && e.message || e) }));
      if (!emailResult.ok) {
        console.error(`[forgot-password] email send failed for ${email}: ${emailResult.error || emailResult.reason || 'unknown'}`);
      }
    }

    // Always respond OK to prevent user enumeration
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    console.error('/api/auth/forgot-password error:', e);
    // Still return ok to prevent leaking info
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  }
};
