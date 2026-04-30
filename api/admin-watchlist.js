// /api/admin-watchlist
//   POST   — create a new watch entry, or update an existing one (id in body)
//   DELETE — archive entry (?id=X). We don't hard-delete; we set status='archived'.
//
// Body for POST:
//   {
//     id: <bigint optional, if updating>,
//     ticker: 'BKNG',
//     target_price: 3800,
//     anchor_type: 'RV' | 'EPV',
//     anchor_value_per_share: 505.58,
//     mos_required_pct: 0.25,            // 0..1 (25% = 0.25)
//     catalyst: 'Q3 2026 booking growth >12%',
//     deadline_review: '2026-09-30',     // optional ISO date
//     notes: '...'                        // optional
//   }
//
// Auth: admin only.

'use strict';

const { sbInsert, sbUpdate, sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

const VALID_ANCHORS = new Set(['RV', 'EPV']);

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
      const id = Number(url.searchParams.get('id'));
      if (!id) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'id required' }));
        return;
      }
      await sbUpdate('watchlist', `id=eq.${id}`, { status: 'archived' });
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, id, archived: true }));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const id = body.id ? Number(body.id) : null;
    const ticker = String(body.ticker || '').toUpperCase().trim();
    const targetPrice = Number(body.target_price);
    const anchorType = String(body.anchor_type || '').toUpperCase().trim();
    const anchorValue = Number(body.anchor_value_per_share);
    const mosPct = Number(body.mos_required_pct);
    const catalyst = body.catalyst ? String(body.catalyst).trim() : null;
    const deadline = body.deadline_review ? String(body.deadline_review).slice(0, 10) : null;
    const notes = body.notes ? String(body.notes).trim() : null;

    // Validate
    if (!ticker) return res.status(400).end(JSON.stringify({ ok: false, error: 'ticker required' }));
    if (!(targetPrice > 0)) return res.status(400).end(JSON.stringify({ ok: false, error: 'target_price must be > 0' }));
    if (!VALID_ANCHORS.has(anchorType)) return res.status(400).end(JSON.stringify({ ok: false, error: 'anchor_type must be RV or EPV' }));
    if (!(anchorValue > 0)) return res.status(400).end(JSON.stringify({ ok: false, error: 'anchor_value_per_share must be > 0' }));
    if (!(mosPct >= 0 && mosPct <= 1)) return res.status(400).end(JSON.stringify({ ok: false, error: 'mos_required_pct must be 0..1' }));

    if (id) {
      // Update path
      const existing = await sbSelect('watchlist', `select=id&id=eq.${id}&limit=1`);
      if (existing.length === 0) {
        res.status(404).end(JSON.stringify({ ok: false, error: 'id not found' }));
        return;
      }
      await sbUpdate('watchlist', `id=eq.${id}`, {
        ticker, target_price: targetPrice, anchor_type: anchorType,
        anchor_value_per_share: anchorValue, mos_required_pct: mosPct,
        catalyst, deadline_review: deadline, notes,
      });
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, id, updated: true }));
      return;
    }

    // Create path. Block if there is already an active watch for the ticker.
    const conflict = await sbSelect('watchlist', `select=id&ticker=eq.${ticker}&status=eq.active&limit=1`);
    if (conflict.length > 0) {
      res.status(409).end(JSON.stringify({ ok: false, error: `ticker ${ticker} already has an active watch (id=${conflict[0].id})` }));
      return;
    }

    const inserted = await sbInsert('watchlist', [{
      ticker, target_price: targetPrice, anchor_type: anchorType,
      anchor_value_per_share: anchorValue, mos_required_pct: mosPct,
      catalyst, deadline_review: deadline, notes,
      status: 'active',
    }]);
    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, id: row.id, created: true }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
