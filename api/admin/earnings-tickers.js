// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar ticker sources (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET    /api/admin/earnings-tickers
//   → { items: [{ ticker, name, sources, in_calendar, last_event_date,
//                  event_count, stage?, watchlist_status? }] }
//
// DELETE /api/admin/earnings-tickers?ticker=XXX[&scope=calendar|universe]
//   → { ok, deleted, deleted_pipeline } — scope=calendar (default) only
//     removes earnings_calendar rows. scope=universe ALSO removes the
//     ticker from pipeline_cards (covered universe) so the cron will
//     never re-import it. watchlist is never touched here.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbDelete } = require('../_supabase');

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return v.email || 'admin';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const actor = requireAuth(req, res);
  if (!actor) return;

  if (req.method === 'DELETE') {
    const ticker = (req.query.ticker || '').toString().toUpperCase().trim();
    const scope = (req.query.scope || 'calendar').toString().toLowerCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      res.status(400).json({ error: 'Invalid ticker' });
      return;
    }
    if (!['calendar', 'universe'].includes(scope)) {
      res.status(400).json({ error: 'Invalid scope (calendar|universe)' });
      return;
    }
    try {
      // Count earnings rows first
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

      res.status(200).json({
        ok: true,
        ticker,
        scope,
        deleted: before.length,
        deleted_pipeline,
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

    const items = Array.from(map.values()).sort((a, b) => {
      // Untracked first (so admin sees what to import), then alphabetical
      if (a.in_calendar !== b.in_calendar) return a.in_calendar ? 1 : -1;
      return a.ticker.localeCompare(b.ticker);
    });

    res.status(200).json({ items, total: items.length });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
};
