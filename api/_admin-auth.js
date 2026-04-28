// Shared helper: verify an admin token issued by /api/admin-login
const crypto = require('crypto');

function verifyAdminToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [scope, expStr, sig] = parts;
  if (scope !== 'admin') return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  const payload = `${scope}.${expStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { verifyAdminToken };
