// Shared helper: enforce role-based access control on API endpoints.
//
// Usage:
//   const { requireRole } = require('./_require-role');
//   const auth = await requireRole(req, ['admin']);
//   if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
//   // continue, auth.user = { email, role, displayName }
//
// Behavior:
//   - Reads x-admin-token header → verifies HMAC → extracts email
//   - Looks up the user in admin_users to get current role (handles role changes
//     without requiring re-login)
//   - Returns { ok: true, user } if the user's role is in `allowedRoles`
//   - Returns { ok: false, status, error } otherwise
//
// Special role: 'any' — accepts any authenticated active user (no role filter).

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect } = require('./_supabase');

async function requireRole(req, allowedRoles) {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET) {
    return { ok: false, status: 500, error: 'Server not configured' };
  }

  const adminTok = req.headers['x-admin-token'];
  if (!adminTok) {
    return { ok: false, status: 401, error: 'Unauthorized: missing token' };
  }

  const verified = verifyAdminToken(adminTok, ADMIN_TOKEN_SECRET);
  if (!verified || !verified.email) {
    return { ok: false, status: 401, error: 'Unauthorized: invalid token' };
  }

  // Lookup current role from admin_users (so role changes take effect immediately
  // without requiring users to re-login).
  let user;
  try {
    const rows = await sbSelect(
      'admin_users',
      `select=email,display_name,role,is_active&email=eq.${encodeURIComponent(verified.email)}&is_active=eq.true&limit=1`
    );
    user = rows[0];
  } catch (e) {
    return { ok: false, status: 500, error: 'Auth lookup failed' };
  }

  if (!user) {
    return { ok: false, status: 401, error: 'Unauthorized: user not found or inactive' };
  }

  if (Array.isArray(allowedRoles) && !allowedRoles.includes('any') && !allowedRoles.includes(user.role)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: role '${user.role}' not allowed (requires: ${allowedRoles.join(', ')})`,
    };
  }

  return {
    ok: true,
    user: {
      email: user.email,
      role: user.role,
      displayName: user.display_name,
    },
  };
}

module.exports = { requireRole };
