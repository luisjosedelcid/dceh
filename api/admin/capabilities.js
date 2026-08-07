// /api/admin/capabilities — CIO-only panel for the RBAC matrix.
//
//   GET   /api/admin/capabilities
//     → { ok: true, capabilities: [{id, domain, description, endpoint, criticality}],
//         roles: ['cio','analyst','viewer'],
//         matrix: { cio: Set<id>, analyst: Set<id>, viewer: Set<id> } }
//
//   PATCH /api/admin/capabilities
//     body: { changes: [{role, capability_id, granted}] }
//     → { ok: true, applied: N }
//
// Guardrails:
//   - Requires capability US-07 (Gestionar matriz RBAC).
//   - CIO row is IMMUTABLE: any change that would set a CIO capability to false
//     is rejected with 403. CIO must always have all capabilities.
//   - Each change is audited to report_audit.
//   - After a successful PATCH, in-memory caches for the affected roles are
//     invalidated so the next endpoint call re-reads the DB.

'use strict';

const { sbSelect, sbInsert, sbUpsert } = require('../_supabase');
const {
  requireCapability,
  invalidateRoleCache,
} = require('../_require-capability');

const EDITABLE_ROLES = ['analyst', 'viewer'];
const ALL_ROLES = ['cio', 'analyst', 'viewer'];

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function audit(actor_email, action, detail) {
  return sbInsert('report_audit', {
    actor_email,
    action,
    folder: 'rbac',
    filename: null,
    detail: detail || null,
  }).catch(() => {});
}

async function handleGet(req, res) {
  const [caps, assignments] = await Promise.all([
    sbSelect(
      'capabilities',
      'select=id,domain,description,endpoint,criticality&order=id.asc'
    ),
    sbSelect(
      'role_capabilities',
      'select=role,capability_id,granted&granted=eq.true'
    ),
  ]);

  const matrix = { cio: [], analyst: [], viewer: [] };
  for (const row of assignments || []) {
    if (matrix[row.role]) matrix[row.role].push(row.capability_id);
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      capabilities: caps || [],
      roles: ALL_ROLES,
      matrix,
    })
  );
}

async function handlePatch(req, res, actor) {
  const body = await readJson(req);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length === 0) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'body.changes must be a non-empty array' }));
    return;
  }
  if (changes.length > 500) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'max 500 changes per request' }));
    return;
  }

  // Validate + protect the CIO row.
  const cleaned = [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'each change must be an object' }));
      return;
    }
    if (!ALL_ROLES.includes(c.role)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `invalid role: ${c.role}` }));
      return;
    }
    if (typeof c.capability_id !== 'string' || !/^[A-Z]{2,4}-\d{2}$/.test(c.capability_id)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `invalid capability_id: ${c.capability_id}` }));
      return;
    }
    if (typeof c.granted !== 'boolean') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'granted must be boolean' }));
      return;
    }
    if (c.role === 'cio' && c.granted === false) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: `Cannot revoke CIO capability (${c.capability_id}). CIO must retain all capabilities.`,
        })
      );
      return;
    }
    cleaned.push({
      role: c.role,
      capability_id: c.capability_id,
      granted: c.granted,
    });
  }

  // Validate capability_ids exist.
  const uniqueIds = [...new Set(cleaned.map((c) => c.capability_id))];
  const inList = uniqueIds.map((s) => `"${s}"`).join(',');
  const existing = await sbSelect(
    'capabilities',
    `select=id&id=in.(${inList})`
  );
  const validIds = new Set((existing || []).map((r) => r.id));
  const invalid = uniqueIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({ error: `unknown capability_id(s): ${invalid.join(', ')}` })
    );
    return;
  }

  // Upsert.
  await sbUpsert('role_capabilities', cleaned, 'role,capability_id');

  // Audit each change.
  const affectedRoles = new Set();
  for (const c of cleaned) {
    affectedRoles.add(c.role);
    audit(
      actor,
      'rbac.matrix_change',
      `${c.role} · ${c.capability_id} → ${c.granted ? 'GRANT' : 'REVOKE'}`
    );
  }

  // Invalidate in-memory cache for affected roles.
  for (const r of affectedRoles) invalidateRoleCache(r);

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, applied: cleaned.length }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    const auth = await requireCapability(req, 'US-07');
    if (!auth.ok) {
      res.statusCode = auth.status;
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }

    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }

    if (req.method === 'PATCH') {
      await handlePatch(req, res, auth.user.email);
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    console.error('/api/admin/capabilities error:', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message || 'Internal error' }));
  }
};
