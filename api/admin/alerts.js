// DCE Holdings — Price Alerts admin API
// GET    /api/admin/alerts                       → list all
// POST   /api/admin/alerts                       → upsert (JSON: ticker, alert_type, threshold, scope?)
// DELETE /api/admin/alerts?id=N                  → hard delete
// POST   /api/admin/alerts?rearm=1&id=N          → re-arm a triggered alert
//
// Auth: x-admin-token header

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

const VALID_TYPES = ['floor', 'ceiling'];
const VALID_SCOPES = ['portfolio', 'covered'];

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

module.exports = async (req, res) => {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // ── Re-arm a triggered alert ─────────────────────
    if (req.method === 'POST' && (req.query.rearm === '1' || req.query.rearm === 'true')) {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      const updated = await sbUpdate('price_alerts', `id=eq.${id}`, {
        active: true,
        triggered_at: null,
        triggered_price: null,
        last_email_sent_at: null,
        updated_at: new Date().toISOString(),
      });
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    // ── List all ────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sbSelect('price_alerts', 'select=*&order=ticker.asc,alert_type.asc&limit=1000');
      res.status(200).json({ items: rows });
      return;
    }

    // ── Upsert (create or replace by ticker+type) ───
    if (req.method === 'POST') {
      const data = await readJson(req);
      const ticker = (data.ticker || '').toString().toUpperCase().trim();
      const alert_type = (data.alert_type || '').toString().toLowerCase().trim();
      const threshold = Number(data.threshold);
      const scope = VALID_SCOPES.includes((data.scope || '').toLowerCase())
        ? data.scope.toLowerCase()
        : 'covered';

      if (!ticker || ticker.length > 12) {
        res.status(400).json({ error: 'ticker required (max 12 chars)' });
        return;
      }
      if (!VALID_TYPES.includes(alert_type)) {
        res.status(400).json({ error: 'alert_type must be floor or ceiling' });
        return;
      }
      if (!Number.isFinite(threshold) || threshold <= 0) {
        res.status(400).json({ error: 'threshold must be a positive number' });
        return;
      }

      // Deactivate any existing active alert for (ticker, alert_type)
      // Then insert fresh. This avoids the partial unique index conflict on re-arm.
      const existing = await sbSelect('price_alerts',
        `select=id&ticker=eq.${encodeURIComponent(ticker)}&alert_type=eq.${alert_type}&active=eq.true`);
      if (existing && existing.length > 0) {
        await sbUpdate('price_alerts',
          `ticker=eq.${encodeURIComponent(ticker)}&alert_type=eq.${alert_type}&active=eq.true`,
          { active: false, updated_at: new Date().toISOString() });
      }

      const rec = {
        ticker,
        alert_type,
        threshold,
        scope,
        active: true,
        created_by: auth.email || null,
      };
      const created = await sbInsert('price_alerts', rec);
      res.status(200).json({ ok: true, item: Array.isArray(created) ? created[0] : created });
      return;
    }

    // ── Hard delete ─────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      await sbDelete('price_alerts', `id=eq.${id}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
