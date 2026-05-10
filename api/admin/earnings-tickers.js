// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar ticker sources (admin-only)
// ───────────────────────────────────────────────────────────────────
// GET /api/admin/earnings-tickers
//   → {
//       items: [
//         { ticker, name, sources: ['pipeline'|'watchlist'|'calendar'],
//           in_calendar: bool, last_event_date: 'YYYY-MM-DD'|null,
//           event_count: number }
//       ]
//     }
//
// Returns one row per ticker drawn from pipeline_cards (covered
// universe) ∪ watchlist ∪ earnings_calendar, so the UI can render a
// single import dialog showing what is already tracked vs what is new.
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect } = require('../_supabase');

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
