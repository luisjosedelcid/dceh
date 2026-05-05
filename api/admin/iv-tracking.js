// DCE Holdings — IV-Tracking admin API
// GET    /api/admin/iv-tracking            → list all entries
// POST   /api/admin/iv-tracking            → create entry (JSON body)
// PATCH  /api/admin/iv-tracking?id=N       → update entry
// DELETE /api/admin/iv-tracking?id=N       → hard delete (rare; usually mistake correction)
//
// Auth: x-admin-token header (admin role)
//
// Body for POST:
//   {
//     ticker: 'MSFT',
//     as_of_date: '2026-06-30',
//     quarter: 'Q2-2026',
//     method: 'IRR' | 'EPV' | 'HYBRID',
//     method_rationale: '...',                  // optional
//     epv_per_share: 134.83,                    // required if method = EPV or HYBRID
//     irr_5y: 0.1758,                           // required if method = IRR or HYBRID (decimal)
//     target_price_5y: 720.00,                  // optional, IRR-driven
//     hurdle_rate: 0.12,                        // optional, default 0.12
//     current_price: 413.62,                    // required
//     thesis_intact: true,                      // optional, default true
//     notes: '...'                              // optional
//   }
//
// signal_zone + gap_pct + iv_change_qoq are computed server-side.

'use strict';

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('../_supabase');

const VALID_METHODS = ['EPV', 'IRR', 'HYBRID'];
const VALID_ZONES = ['fat_pitch', 'buy_hold', 'fair', 'expensive', 'bubble'];

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

// Compute signal_zone given method, gap, etc.
// EPV-driven: gap = (EPV − Price) / Price
//   > +30%        → fat_pitch
//   +10 to +30    → buy_hold
//   −10 to +10    → fair
//   −30 to −10    → expensive
//   < −30%        → bubble
//
// IRR-driven: gap = IRR − hurdle (in decimal points, e.g. 0.05 = 5pp)
//   > +0.05 (IRR ≥ 17%) → fat_pitch
//   +0 to +0.05         → buy_hold
//   −0.02 to 0          → fair
//   −0.05 to −0.02      → expensive
//   < −0.05             → bubble
function computeSignal({ method, epv_per_share, irr_5y, hurdle_rate, current_price }) {
  const hurdle = (hurdle_rate != null) ? Number(hurdle_rate) : 0.12;

  if (method === 'EPV' || method === 'HYBRID') {
    if (epv_per_share == null || current_price == null || Number(current_price) <= 0) return { zone: null, gap_pct: null };
    const gap = (Number(epv_per_share) - Number(current_price)) / Number(current_price);
    let zone;
    if (gap > 0.30)        zone = 'fat_pitch';
    else if (gap > 0.10)   zone = 'buy_hold';
    else if (gap >= -0.10) zone = 'fair';
    else if (gap >= -0.30) zone = 'expensive';
    else                   zone = 'bubble';
    return { zone, gap_pct: Number(gap.toFixed(4)) };
  }

  if (method === 'IRR') {
    if (irr_5y == null) return { zone: null, gap_pct: null };
    const gap = Number(irr_5y) - hurdle;
    let zone;
    if (gap > 0.05)        zone = 'fat_pitch';
    else if (gap >= 0)     zone = 'buy_hold';
    else if (gap >= -0.02) zone = 'fair';
    else if (gap >= -0.05) zone = 'expensive';
    else                   zone = 'bubble';
    return { zone, gap_pct: Number(gap.toFixed(4)) };
  }

  return { zone: null, gap_pct: null };
}

// Find previous entry for IV change-on-quarter (only meaningful when method matches)
async function computeIvChangeQoq(ticker, method, current_iv) {
  if (current_iv == null) return null;
  const rows = await sbSelect(
    'iv_tracking',
    `select=epv_per_share,irr_5y,target_price_5y,method&ticker=eq.${encodeURIComponent(ticker)}&order=as_of_date.desc&limit=5`
  );
  // Find most recent entry with same method
  const prev = rows.find(r => r.method === method);
  if (!prev) return null;
  if (method === 'EPV' || method === 'HYBRID') {
    if (prev.epv_per_share == null) return null;
    return Number(((Number(current_iv) - Number(prev.epv_per_share)) / Number(prev.epv_per_share)).toFixed(4));
  }
  if (method === 'IRR') {
    if (prev.irr_5y == null) return null;
    // For IRR, "iv_change" is delta in IRR points
    return Number((Number(current_iv) - Number(prev.irr_5y)).toFixed(4));
  }
  return null;
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
    if (req.method === 'GET') {
      const rows = await sbSelect('iv_tracking', 'select=*&order=ticker.asc,as_of_date.desc&limit=1000');
      res.status(200).json({ items: rows });
      return;
    }

    if (req.method === 'POST') {
      const data = await readJson(req);
      const ticker = (data.ticker || '').toString().toUpperCase().trim();
      const as_of_date = (data.as_of_date || '').toString().trim();
      const quarter = (data.quarter || '').toString().trim();
      const method = (data.method || '').toString().toUpperCase().trim();

      if (!ticker || ticker.length > 12) {
        res.status(400).json({ error: 'ticker required (max 12 chars)' });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of_date)) {
        res.status(400).json({ error: 'as_of_date must be YYYY-MM-DD' });
        return;
      }
      if (!quarter || quarter.length > 16) {
        res.status(400).json({ error: 'quarter required (e.g. Q1-2026)' });
        return;
      }
      if (!VALID_METHODS.includes(method)) {
        res.status(400).json({ error: `method must be one of: ${VALID_METHODS.join(', ')}` });
        return;
      }

      const epv_per_share = data.epv_per_share != null && data.epv_per_share !== '' ? Number(data.epv_per_share) : null;
      const irr_5y = data.irr_5y != null && data.irr_5y !== '' ? Number(data.irr_5y) : null;
      const target_price_5y = data.target_price_5y != null && data.target_price_5y !== '' ? Number(data.target_price_5y) : null;
      const hurdle_rate = data.hurdle_rate != null && data.hurdle_rate !== '' ? Number(data.hurdle_rate) : 0.12;
      const current_price = Number(data.current_price);

      if (!(current_price > 0)) {
        res.status(400).json({ error: 'current_price must be > 0' });
        return;
      }
      if ((method === 'EPV' || method === 'HYBRID') && !(epv_per_share > 0)) {
        res.status(400).json({ error: 'epv_per_share required when method=EPV/HYBRID (must be > 0)' });
        return;
      }
      if ((method === 'IRR' || method === 'HYBRID') && irr_5y == null) {
        res.status(400).json({ error: 'irr_5y required when method=IRR/HYBRID (decimal, e.g. 0.1758)' });
        return;
      }

      // Compute signal + gap_pct
      const { zone, gap_pct } = computeSignal({ method, epv_per_share, irr_5y, hurdle_rate, current_price });

      // Compute iv_change_qoq vs previous entry of same method
      let iv_change_qoq = null;
      if (method === 'EPV' || method === 'HYBRID') {
        iv_change_qoq = await computeIvChangeQoq(ticker, method, epv_per_share);
      } else if (method === 'IRR') {
        iv_change_qoq = await computeIvChangeQoq(ticker, method, irr_5y);
      }

      const rec = {
        ticker,
        as_of_date,
        quarter,
        method,
        method_rationale: (data.method_rationale || '').toString().slice(0, 4000) || null,
        epv_per_share,
        irr_5y,
        target_price_5y,
        hurdle_rate,
        current_price,
        signal_zone: zone,
        gap_pct,
        thesis_intact: data.thesis_intact != null ? Boolean(data.thesis_intact) : true,
        iv_change_qoq,
        notes: (data.notes || '').toString().slice(0, 4000) || null,
        created_by: auth.email || null,
      };

      const created = await sbInsert('iv_tracking', rec);
      res.status(200).json({ ok: true, item: Array.isArray(created) ? created[0] : created });
      return;
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      const data = await readJson(req);
      const allowed = [
        'as_of_date', 'quarter', 'method', 'method_rationale',
        'epv_per_share', 'irr_5y', 'target_price_5y', 'hurdle_rate',
        'current_price', 'thesis_intact', 'notes',
      ];
      const patch = {};
      for (const k of allowed) if (k in data) patch[k] = data[k];

      // Re-compute signal if anything affecting it changed
      const before = await sbSelect('iv_tracking', `select=*&id=eq.${id}&limit=1`);
      const prev = before[0];
      if (!prev) {
        res.status(404).json({ error: 'id not found' });
        return;
      }
      const merged = { ...prev, ...patch };
      const { zone, gap_pct } = computeSignal({
        method: merged.method,
        epv_per_share: merged.epv_per_share,
        irr_5y: merged.irr_5y,
        hurdle_rate: merged.hurdle_rate,
        current_price: merged.current_price,
      });
      patch.signal_zone = zone;
      patch.gap_pct = gap_pct;

      const updated = await sbUpdate('iv_tracking', `id=eq.${id}`, patch);
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      await sbDelete('iv_tracking', `id=eq.${id}`);
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
