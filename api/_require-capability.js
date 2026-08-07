// Shared helper: capability-based access control (RBAC granular).
//
// Migration path from _require-role.js:
//   - Old:  const auth = await requireRole(req, ['admin']);
//   - New:  const auth = await requireCapability(req, 'DJ-03');
//
// Behavior:
//   - Reads x-admin-token → verifies HMAC → extracts email.
//   - Looks up the user in admin_users (email + is_active).
//   - Checks role_capabilities WHERE role=<user.role> AND capability_id=<cap>.
//   - Cache in-memory de la matriz (role → Set<capability_id>) con TTL 60s.
//   - Fallback: si el rol es 'admin' (legacy), concede todas las capacidades.
//
// Returns:
//   { ok: true, user: { email, role, displayName } }
//   { ok: false, status, error }
//
// Special:
//   - requireCapability(req, null) → solo autentica, no chequea capacidad.
//     Útil para GET /api/me y endpoints que solo requieren usuario activo.

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect } = require('./_supabase');

// ============================================================================
// Cache in-memory
// ============================================================================
// { role: { caps: Set<string>, expiresAt: number } }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 segundos

async function loadCapsForRole(role) {
  const now = Date.now();
  const cached = cache.get(role);
  if (cached && cached.expiresAt > now) return cached.caps;

  try {
    const rows = await sbSelect(
      'role_capabilities',
      `select=capability_id&role=eq.${encodeURIComponent(role)}&granted=eq.true`
    );
    const caps = new Set((rows || []).map((r) => r.capability_id));
    cache.set(role, { caps, expiresAt: now + CACHE_TTL_MS });
    return caps;
  } catch (e) {
    // Si Supabase falla, devolver Set vacío (deny all salvo admin legacy)
    return new Set();
  }
}

function invalidateRoleCache(role) {
  if (role) cache.delete(role);
  else cache.clear();
}

// ============================================================================
// Helper principal
// ============================================================================
async function requireCapability(req, capabilityId) {
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

  // Lookup current role from admin_users
  let user;
  try {
    const rows = await sbSelect(
      'admin_users',
      `select=email,display_name,role,is_active&email=eq.${encodeURIComponent(
        verified.email
      )}&is_active=eq.true&limit=1`
    );
    user = rows[0];
  } catch (e) {
    return { ok: false, status: 500, error: 'Auth lookup failed' };
  }

  if (!user) {
    return { ok: false, status: 401, error: 'Unauthorized: user not found or inactive' };
  }

  // Si capabilityId es null → solo autenticar, no chequear capacidad
  if (!capabilityId) {
    return {
      ok: true,
      user: { email: user.email, role: user.role, displayName: user.display_name },
    };
  }

  // Fallback legacy: admin ve todo
  if (user.role === 'admin') {
    return {
      ok: true,
      user: { email: user.email, role: user.role, displayName: user.display_name },
    };
  }

  // Chequeo capacidad
  const caps = await loadCapsForRole(user.role);
  if (!caps.has(capabilityId)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: role '${user.role}' lacks capability '${capabilityId}'`,
    };
  }

  return {
    ok: true,
    user: { email: user.email, role: user.role, displayName: user.display_name },
  };
}

// ============================================================================
// Helper de conveniencia: devuelve todas las capacidades de un usuario
// Uso: en /api/me para poblar UI.
// ============================================================================
async function loadCapabilitiesForUser(req) {
  const auth = await requireCapability(req, null);
  if (!auth.ok) return { ok: false, ...auth };

  const role = auth.user.role;
  // admin legacy → todas las capacidades del catálogo
  if (role === 'admin') {
    try {
      const rows = await sbSelect('capabilities', 'select=id');
      return { ok: true, user: auth.user, capabilities: (rows || []).map((r) => r.id) };
    } catch (e) {
      return { ok: true, user: auth.user, capabilities: [] };
    }
  }

  const caps = await loadCapsForRole(role);
  return { ok: true, user: auth.user, capabilities: [...caps] };
}

module.exports = {
  requireCapability,
  loadCapabilitiesForUser,
  invalidateRoleCache,
};
