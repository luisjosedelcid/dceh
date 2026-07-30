// POST /api/auth/reset-password
// Body: { token: string, new_password: string }
// Response: { ok: true } or { error }
//
// - Hashes the incoming token, looks up the matching row in password_reset_tokens
// - Rejects if used_at is set, expired, or not found (all return generic 400)
// - Marks token as used, hashes new_password with bcrypt cost 10,
//   updates admin_users.password_hash, and writes an audit row.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sbSelect, sbUpdate, sbInsert } = require('../_supabase');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
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

async function audit(actor, action, detail) {
  try {
    await sbInsert('audit_log', {
      actor_email: actor,
      action,
      detail: detail ? String(detail).slice(0, 500) : null,
    });
  } catch { /* best-effort */ }
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
    const rawToken = String(body.token || '').trim();
    const newPassword = String(body.new_password || '');

    if (!rawToken || rawToken.length < 20) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Token inválido' }));
      return;
    }
    if (newPassword.length < 8) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'La contraseña nueva debe tener al menos 8 caracteres' }));
      return;
    }

    const tokenHash = sha256(rawToken);
    const nowIso = new Date().toISOString();

    // Find token row
    const rows = await sbSelect(
      'password_reset_tokens',
      `select=id,email,expires_at,used_at&token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`
    );
    const row = rows[0];
    if (!row) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Link inválido o ya utilizado' }));
      return;
    }
    if (row.used_at) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Este link ya fue utilizado. Solicitá uno nuevo.' }));
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'El link expiró. Solicitá uno nuevo.' }));
      return;
    }

    // Verify user still exists and active
    const users = await sbSelect(
      'admin_users',
      `select=email,is_active&email=eq.${encodeURIComponent(row.email)}&limit=1`
    );
    const user = users[0];
    if (!user || !user.is_active) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Usuario no encontrado o inactivo' }));
      return;
    }

    // All checks passed — apply new password
    const newHash = await bcrypt.hash(newPassword, 10);
    await sbUpdate(
      'admin_users',
      `email=eq.${encodeURIComponent(row.email)}`,
      { password_hash: newHash }
    );

    // Mark token as used
    await sbUpdate(
      'password_reset_tokens',
      `id=eq.${row.id}`,
      { used_at: nowIso }
    );

    // Invalidate all other unused tokens for this email
    await sbUpdate(
      'password_reset_tokens',
      `email=eq.${encodeURIComponent(row.email)}&used_at=is.null&id=neq.${row.id}`,
      { used_at: nowIso }
    );

    await audit(row.email, 'user.password_reset_via_email', `token_id=${row.id}`);

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, email: row.email }));
  } catch (e) {
    console.error('/api/auth/reset-password error:', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Error interno' }));
  }
};
