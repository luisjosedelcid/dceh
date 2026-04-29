// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar (public read endpoint)
// GET /api/earnings?days=90&status=upcoming|reported|all&ticker=XXX
//
// Reads from earnings_calendar (Supabase) and returns the events in a
// shape compatible with calendar.html and the home widget.
//
// Public read — no auth required (data is non-sensitive market data).
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('./_supabase.js');

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function deriveQuarter(dateIso) {
  // Booking, SAP, MSFT… reportan ~1 mes después del cierre de Q.
  // Aproximación: el quarter reportado = quarter calendario anterior.
  if (!dateIso) return '';
  const d = new Date(dateIso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  const month = d.getUTCMonth() + 1; // 1-12
  const year = d.getUTCFullYear();
  // Earnings reports normalmente cubren el quarter previo
  let q, y;
  if (month <= 3)        { q = 4; y = year - 1; }
  else if (month <= 6)   { q = 1; y = year; }
  else if (month <= 9)   { q = 2; y = year; }
  else                   { q = 3; y = year; }
  return `Q${q} ${y}`;
}

module.exports = async (req, res) => {
  // CORS / cache: data refreshes daily, allow short edge cache
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const days   = clampInt(req.query.days, 90, 1, 365);
    const status = (req.query.status || 'upcoming').toLowerCase();
    const ticker = (req.query.ticker || '').toString().trim().toUpperCase();

    const fromIso = todayIso();
    const toIso   = plusDaysIso(days);

    // PostgREST query
    const params = [];
    params.push('select=ticker,date,company,hour,timing,eps_estimate,eps_actual,revenue_estimate,revenue_actual,ir_url,status,fetched_at,updated_at');

    // Si status=reported, queremos eventos pasados también (último año)
    if (status === 'reported') {
      params.push(`date=gte.${plusDaysIso(-365)}`);
      params.push(`date=lte.${todayIso()}`);
      params.push(`status=eq.reported`);
    } else if (status === 'all') {
      params.push(`date=gte.${plusDaysIso(-365)}`);
      params.push(`date=lte.${toIso}`);
    } else {
      // upcoming (default)
      params.push(`date=gte.${fromIso}`);
      params.push(`date=lte.${toIso}`);
      params.push(`status=eq.upcoming`);
    }

    if (ticker) {
      params.push(`ticker=eq.${ticker}`);
    }

    params.push('order=date.asc');
    params.push('limit=500');

    const rows = await sbSelect('earnings_calendar', params.join('&'));

    const events = rows.map(r => ({
      id: `${r.ticker}-${r.date}`,
      ticker: r.ticker,
      company: r.company || r.ticker,
      date: r.date,
      hour: r.hour || null,
      timing: r.timing || 'TBD',
      timezone: 'ET',
      quarter: deriveQuarter(r.date),
      eps_estimate: r.eps_estimate,
      eps_actual: r.eps_actual,
      revenue_estimate: r.revenue_estimate,
      revenue_actual: r.revenue_actual,
      ir_url: r.ir_url || null,
      status: r.status || 'upcoming',
    }));

    // last_updated = MAX(updated_at) entre las filas devueltas
    let lastUpdated = null;
    for (const r of rows) {
      const t = r.updated_at || r.fetched_at;
      if (t && (!lastUpdated || t > lastUpdated)) lastUpdated = t;
    }

    res.status(200).json({
      events,
      total: events.length,
      from: fromIso,
      to: toIso,
      status,
      ticker: ticker || null,
      last_updated: lastUpdated,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load earnings', detail: String(e).slice(0, 200) });
  }
};
