// Shared helpers for admin auth.
// Token format: "admin.<expiresAt>.<emailB64Url>.<sig>"
//   - sig = HMAC-SHA256( "admin.<expiresAt>.<emailB64Url>", ADMIN_TOKEN_SECRET )
// Backward-compat: legacy 3-part tokens "admin.<expiresAt>.<sig>" are still
// accepted (verifyAdminToken returns true) but will resolve to email = null.
// Login always issues 4-part tokens going forward.

const crypto = require('crypto');

const TOKEN_TTL_SEC = 8 * 60 * 60; // 8 hours

function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function signToken(email, secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const emailB64 = b64urlEncode(email);
  const payload = `admin.${expiresAt}.${emailB64}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}

function verifyAdminToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;

  const scope = parts[0];
  const expStr = parts[1];
  if (scope !== 'admin') return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  let payload, sig, email = null;
  if (parts.length === 4) {
    email = (() => { try { return b64urlDecode(parts[2]); } catch { return null; } })();
    payload = `${scope}.${expStr}.${parts[2]}`;
    sig = parts[3];
  } else {
    payload = `${scope}.${expStr}`;
    sig = parts[2];
  }

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig.length !== expected.length) return null;
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    if (!ok) return null;
  } catch {
    return null;
  }
  return { email, exp };
}

module.exports = { verifyAdminToken, signToken, TOKEN_TTL_SEC };
