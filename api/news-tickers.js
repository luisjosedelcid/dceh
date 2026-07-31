// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — News tickers per-user CRUD
// ───────────────────────────────────────────────────────────────────
// Persists the list of tickers each user tracks in News Tracker.
//
//   GET    /api/news-tickers
//          → { items: [{ ticker, source, added_at }] }
//   POST   /api/news-tickers
//          body: { ticker, source? }   source in ('shortlist','universe','manual')
//          → { item }
//   DELETE /api/news-tickers?ticker=<T>
//          → { ok: true }
//
// Auth: x-admin-token. user_id resolved from token email -> admin_users.id.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect, sbInsert, sbDelete } = require('./_supabase');

async function resolveUserId(email) {
  const rows = await sbSelect(
    'admin_users',
    `select=id&email=eq.${encodeURIComponent(email)}&limit=1`
  );
  return rows.length ? rows[0].id : null;
}

async function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v || !v.email) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const uid = await resolveUserId(v.email);
  if (!uid) { res.status(401).json({ error: 'Unknown user' }); return null; }
  return { userId: uid, email: v.email };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function normalizeTicker(t) {
  return (t || '').toString().trim().toUpperCase().slice(0, 12);
}

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  try {
    if (req.method === 'GET') {
      const items = await sbSelect(
        'user_news_tickers',
        `select=ticker,source,added_at&user_id=eq.${userId}&order=added_at.asc&limit=200`
      );
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const ticker = normalizeTicker(body.ticker);
      const source = ['shortlist', 'universe', 'manual'].includes(body.source) ? body.source : 'manual';
      if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)) {
        res.status(400).json({ error: 'invalid ticker' });
        return;
      }
      // Idempotent: skip if already there
      const existing = await sbSelect(
        'user_news_tickers',
        `select=ticker&user_id=eq.${userId}&ticker=eq.${ticker}&limit=1`
      );
      if (existing.length > 0) {
        res.status(200).json({ item: existing[0], created: false });
        return;
      }
      const inserted = await sbInsert('user_news_tickers', {
        user_id: userId,
        ticker,
        source,
      });
      const item = Array.isArray(inserted) ? inserted[0] : inserted;
      res.status(200).json({ item, created: true });
      return;
    }

    if (req.method === 'DELETE') {
      const ticker = normalizeTicker(req.query.ticker || '');
      if (!ticker) { res.status(400).json({ error: 'ticker required' }); return; }
      await sbDelete('user_news_tickers', `user_id=eq.${userId}&ticker=eq.${ticker}`);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('news-tickers failed:', e.message);
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
};
