// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Radar (a.k.a. "Watchlist" in the UI) CRUD (admin-only)
// ───────────────────────────────────────────────────────────────────
// "Radar" = simple list of names on the radar (ticker + thesis + link).
// Distinct from the older `watchlist` table which holds price-target alerts.
//
// All requests require x-admin-token. Bypasses RLS via service role.
//
//   GET    /api/admin/radar
//          → { items: [...] }
//   POST   /api/admin/radar
//          body: { ticker, name?, thesis?, link?, added_at? }
//          → { item: {...} }
//   PATCH  /api/admin/radar?id=<uuid>
//          body: any subset of { name, thesis, link, added_at }
//          → { item: {...} }
//   DELETE /api/admin/radar?id=<uuid>
//          → { ok: true }
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const v = verifyAdminToken(tok, secret);
  if (!v) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return v.email || 'admin';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function isValidUrl(s) {
  if (!s) return true; // null/empty allowed
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

module.exports = async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'radar',
        'select=*&order=added_at.desc,created_at.desc&limit=500'
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const ticker = (body.ticker || '').toString().toUpperCase().trim();
      const name = (body.name || '').toString().trim();
      const thesis = body.thesis ? String(body.thesis).trim() : '';
      const link = body.link ? String(body.link).trim() : null;
      const added_at = body.added_at && isValidDate(body.added_at)
        ? body.added_at
        : new Date().toISOString().slice(0, 10);

      if (!ticker || !/^[A-Z0-9.\-]{1,15}$/.test(ticker)) {
        res.status(400).json({ error: 'Invalid ticker' });
        return;
      }
      if (link && !isValidUrl(link)) {
        res.status(400).json({ error: 'Invalid link URL' });
        return;
      }
      if (thesis.length > 2000) {
        res.status(400).json({ error: 'Thesis too long (max 2000)' });
        return;
      }

      // Check uniqueness (case-insensitive)
      const existing = await sbSelect(
        'radar',
        `select=id,ticker&ticker=eq.${encodeURIComponent(ticker)}&limit=1`
      );
      if (existing && existing.length > 0) {
        res.status(409).json({ error: `${ticker} is already on the radar` });
        return;
      }

      const row = {
        ticker,
        name,
        thesis,
        link,
        added_at,
        created_by: actor,
        updated_by: actor,
      };

      const result = await sbInsert('radar', row);
      const item = Array.isArray(result) ? result[0] : result;
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }

      const body = parseBody(req);
      const patch = { updated_by: actor, updated_at: new Date().toISOString() };

      if (body.name !== undefined) patch.name = String(body.name).trim();
      if (body.thesis !== undefined) {
        const t = String(body.thesis || '').trim();
        if (t.length > 2000) { res.status(400).json({ error: 'Thesis too long' }); return; }
        patch.thesis = t;
      }
      if (body.link !== undefined) {
        const l = body.link ? String(body.link).trim() : null;
        if (l && !isValidUrl(l)) { res.status(400).json({ error: 'Invalid link URL' }); return; }
        patch.link = l;
      }
      if (body.added_at !== undefined) {
        if (!isValidDate(body.added_at)) { res.status(400).json({ error: 'Invalid added_at' }); return; }
        patch.added_at = body.added_at;
      }

      const result = await sbUpdate('radar', `id=eq.${id}`, patch);
      const item = Array.isArray(result) ? result[0] : result;
      if (!item) {
        res.status(404).json({ error: 'Radar entry not found' });
        return;
      }
      res.status(200).json({ item });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').toString();
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      await sbDelete('radar', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
