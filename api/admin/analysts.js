// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Analysts CRUD (admin-only)
// ───────────────────────────────────────────────────────────────────
// Catalog of analysts who can be assigned as owner on Kanban cards.
// Independent from the auth `users` table — a person can be an
// "assignable owner" without necessarily having login credentials.
//
//   GET    /api/admin/analysts                  → list all
//   GET    /api/admin/analysts?active=1         → only active
//   POST   /api/admin/analysts                  → create
//          body: { name, initials, email?, color?, active? }
//   PATCH  /api/admin/analysts?id=<uuid>        → update
//          body: any subset of { name, initials, email, color, active }
//   DELETE /api/admin/analysts?id=<uuid>        → soft-delete (active=false)
//                                                 use ?hard=1 to truly remove
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

function normalizeInitials(s) {
  const t = (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t.slice(0, 3);
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const onlyActive = req.query && (req.query.active === '1' || req.query.active === 'true');
      const q = onlyActive
        ? 'select=*&active=eq.true&order=name.asc'
        : 'select=*&order=active.desc,name.asc';
      const items = await sbSelect('analysts', q);
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const name = (body.name || '').toString().trim();
      const initials = normalizeInitials(body.initials);
      const email = body.email ? String(body.email).trim().toLowerCase() : null;
      const color = (body.color || '#b88b47').toString();
      const active = body.active === undefined ? true : !!body.active;

      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      if (!initials || initials.length < 1 || initials.length > 3) {
        res.status(400).json({ error: 'Initials must be 1-3 letters/digits' }); return;
      }
      if (email && !EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Invalid email' }); return;
      }
      if (!COLOR_RE.test(color)) {
        res.status(400).json({ error: 'Color must be a hex like #b88b47' }); return;
      }

      const row = { name, initials, email, color, active };
      const result = await sbInsert('analysts', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
      const body = parseBody(req);
      const patch = {};

      if (body.name !== undefined) {
        const n = String(body.name).trim();
        if (!n) { res.status(400).json({ error: 'Name cannot be empty' }); return; }
        patch.name = n;
      }
      if (body.initials !== undefined) {
        const i = normalizeInitials(body.initials);
        if (i.length < 1 || i.length > 3) { res.status(400).json({ error: 'Initials 1-3 chars' }); return; }
        patch.initials = i;
      }
      if (body.email !== undefined) {
        const e = body.email ? String(body.email).trim().toLowerCase() : null;
        if (e && !EMAIL_RE.test(e)) { res.status(400).json({ error: 'Invalid email' }); return; }
        patch.email = e;
      }
      if (body.color !== undefined) {
        const c = String(body.color);
        if (!COLOR_RE.test(c)) { res.status(400).json({ error: 'Invalid color' }); return; }
        patch.color = c;
      }
      if (body.active !== undefined) patch.active = !!body.active;

      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'No fields to update' }); return;
      }

      const result = await sbUpdate('analysts', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      if (!item) { res.status(404).json({ error: 'Analyst not found' }); return; }
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
      const hard = req.query.hard === '1' || req.query.hard === 'true';
      if (hard) {
        await sbDelete('analysts', `id=eq.${id}`);
      } else {
        await sbUpdate('analysts', `id=eq.${id}`, { active: false });
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[analysts] error:', err);
    res.status(500).json({ error: String(err && err.message || err).slice(0, 300) });
  }
};
