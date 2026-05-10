// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar ticker sources (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET    /api/admin/earnings-tickers
//   → { items: [{ ticker, name, sources, in_calendar, last_event_date,
//                  event_count, stage?, watchlist_status?, blocked }] }
//
// DELETE /api/admin/earnings-tickers?ticker=XXX[&scope=calendar|universe]
//   → { ok, deleted, deleted_pipeline, blocked } — scope=calendar (default)
//     removes earnings_calendar rows AND adds the ticker to
//     calendar_blocklist so the cron / refresh will not re-import it.
//     scope=universe also drops the pipeline_cards row (still adds the
//     blocklist row as a safety net). watchlist is never touched here.
//
// POST   /api/admin/earnings-tickers?action=unblock&ticker=XXX
//   → { ok, removed } — removes ticker from calendar_blocklist so the
//     next cron / refresh can pull its events again.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbDelete, sbUpsert } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

function validTicker(t) {
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const actor = requireAuth(req, res);
  if (!actor) return;

  if (req.method === 'POST') {
    const action = (req.query.action || '').toString().toLowerCase();
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    if (action !== 'unblock') {
      res.status(400).json({ error: 'Unknown action (expected ?action=unblock)' });
      return;
    }
    if (!validTicker(ticker)) {
      res.status(400).json({ error: 'Invalid ticker' });
      return;
    }
    try {
      const before = await sbSelect('calendar_blocklist', `select=ticker&ticker=eq.${ticker}`);
      await sbDelete('calendar_blocklist', `ticker=eq.${ticker}`);
      res.status(200).json({ ok: true, ticker, removed: before.length });
    } catch (e) {
      res.status(500).json({ error: String(e).slice(0, 300) });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    const scope = (req.query.scope || 'calendar').toString().toLowerCase();
    const reason = (req.query.reason || '').toString().slice(0, 200) || null;
    if (!validTicker(ticker)) {
      res.status(400).json({ error: 'Invalid ticker' });
      return;
    }
    if (!['calendar', 'universe'].includes(scope)) {
      res.status(400).json({ error: 'Invalid scope (calendar|universe)' });
      return;
    }
    try {
      const before = await sbSelect('earnings_calendar', `select=ticker&ticker=eq.${ticker}`);
      await sbDelete('earnings_calendar', `ticker=eq.${ticker}`);

      let deleted_pipeline = 0;
      if (scope === 'universe') {
        const cards = await sbSelect('pipeline_cards', `select=id&ticker=eq.${ticker}`);
        if (cards.length) {
          await sbDelete('pipeline_cards', `ticker=eq.${ticker}`);
          deleted_pipeline = cards.length;
        }
      }

      // Add to blocklist so future cron / refresh runs skip it. Even with
      // scope=universe we keep this as a safety net (it's idempotent).
      let blocked = false;
      try {
        await sbUpsert('calendar_blocklist', [{
          ticker,
          reason: reason || (scope === 'universe' ? 'Removed from calendar + universe' : 'Removed from calendar'),
          added_by: actor,
          added_at: new Date().toISOString(),
        }], 'ticker');
        blocked = true;
      } catch (e) {
        console.error('calendar_blocklist upsert failed:', String(e).slice(0, 200));
      }

      res.status(200).json({
        ok: true,
        ticker,
        scope,
        deleted: before.length,
        deleted_pipeline,
        blocked,
      });
    } catch (e) {
      res.status(500).json({ error: String(e).slice(0, 300) });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const map = new Map(); // ticker -> row

    function ensure(tk, name) {
      const t = String(tk || '').toUpperCase().trim();
      if (!t) return null;
      if (!map.has(t)) {
        map.set(t, {
          ticker: t,
          name: name || t,
          sources: [],
          in_calendar: false,
          event_count: 0,
          last_event_date: null,
          blocked: false,
        });
      } else if (name && map.get(t).name === t) {
        map.get(t).name = name;
      }
      return map.get(t);
    }

    // 1) covered universe
    try {
      const cards = await sbSelect('pipeline_cards', 'select=ticker,name,stage&limit=500');
      cards.forEach(c => {
        const r = ensure(c.ticker, c.name);
        if (r) {
          r.sources.push('pipeline');
          r.stage = c.stage || null;
        }
      });
    } catch {}

    // 2) watchlist
    try {
      const wl = await sbSelect('watchlist', 'select=ticker,status&limit=500');
      wl.forEach(w => {
        const r = ensure(w.ticker);
        if (r) {
          r.sources.push('watchlist');
          r.watchlist_status = w.status || null;
        }
      });
    } catch {}

    // 3) earnings_calendar (so we know what is already tracked)
    try {
      const ev = await sbSelect('earnings_calendar', 'select=ticker,date,company&limit=2000');
      ev.forEach(e => {
        const r = ensure(e.ticker, e.company);
        if (r) {
          if (!r.sources.includes('calendar')) r.sources.push('calendar');
          r.in_calendar = true;
          r.event_count += 1;
          if (e.date && (!r.last_event_date || e.date > r.last_event_date)) {
            r.last_event_date = e.date;
          }
        }
      });
    } catch {}

    // 4) blocklist (so the UI can mark blocked tickers + show Unblock)
    try {
      const bl = await sbSelect('calendar_blocklist', 'select=ticker,reason,added_at,added_by&limit=500');
      bl.forEach(b => {
        const r = ensure(b.ticker);
        if (r) {
          r.blocked = true;
          r.blocked_reason = b.reason || null;
          r.blocked_at = b.added_at || null;
          r.blocked_by = b.added_by || null;
          if (!r.sources.includes('blocklist')) r.sources.push('blocklist');
        }
      });
    } catch {}

    const items = Array.from(map.values()).sort((a, b) => {
      // Blocked first (so admin sees them), then untracked, then alphabetical
      const aBlocked = !!a.blocked, bBlocked = !!b.blocked;
      if (aBlocked !== bBlocked) return aBlocked ? -1 : 1;
      if (a.in_calendar !== b.in_calendar) return a.in_calendar ? 1 : -1;
      return a.ticker.localeCompare(b.ticker);
    });

    res.status(200).json({ items, total: items.length });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
};
