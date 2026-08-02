// ═══════════════════════════════════════════════════════════════════
// GET /api/dashboard-universe-rows → { rows: [ { ticker, name, sector,
//   shares, debt, cash, wacc, nopatNorm, bridgeAdj, distYield, ... } ] }
//
// Returns UNIVERSE-shaped rows synthesized from company_dashboards
// (is_latest=true), so /universe.html can render them in the In Research
// table alongside the hardcoded UNIVERSE array.
//
// Fields target the shape consumed by universe.html:calcCompany + UNIVERSE
// entries (BKNG/MSFT/etc.). Any published dashboard whose ticker is NOT
// already in UNIVERSE will appear here.
// ═══════════════════════════════════════════════════════════════════

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

// Pull a nested numeric value defensively. Returns null if missing.
function n(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

// Convert a "17.58" (already-percent) IRR-family field to a fraction. Some
// dashboards store as decimals (0.1758), some as percents (17.58). Assume
// >1 means percent.
function toFrac(x) {
  if (x == null) return null;
  return Math.abs(x) > 1 ? x / 100 : x;
}

function synthRow(payload) {
  const ticker = String(payload.ticker || '').toUpperCase();
  if (!ticker) return null;

  const o = payload.overview || {};
  const epv = payload.epv || {};
  const rv = payload.rv || {};
  const irr = payload.irr || {};

  const shares = n(o, 'shares');
  const debt = n(o, 'debt') || 0;
  const leases = n(o, 'leases') || 0;
  const cash = n(o, 'cash') || 0;
  const nopatNorm = n(o, 'nopatNorm');
  const wacc = n(o, 'wacc');
  const defaultPrice = n(o, 'stockPrice');
  const hurdle = n(o, 'hurdle') || 0.12;

  // Bridge adjustment: EPV per-share ops minus per-share equity delta.
  // Fallback: excessCash + ltInv - debt - leases (as universe.html does).
  const excessCash = n(epv, 'excessCash') || 0;
  const ltInv = n(epv, 'ltInv') || 0;
  const bridgeAdj = excessCash + ltInv - debt - leases;

  return {
    ticker,
    name: payload.name || ticker,
    sector: payload.exchange ? `${payload.exchange} · ${payload.industry || ''}`.replace(/·\s*$/, '') : (payload.industry || ''),
    link: `/company.html?ticker=${encodeURIComponent(ticker)}`,
    currency: payload.currencySymbol || '$',
    finnhubSymbol: payload.finnhubSymbol || ticker,
    // shape used by calcCompany
    shares: shares || 0,
    debt: debt + leases,          // total debt used in EV: debt + leases
    cash,
    defaultPrice: defaultPrice || 0,
    nopatNorm: nopatNorm || 0,
    wacc: wacc || 0.09,
    excessCash,
    bridgeAdj,
    // IRR block
    distYield: toFrac(n(irr, 'distYield')) || 0,
    reinvGrowth: toFrac(n(irr, 'reinvGrowth')) || 0,
    organicGrowth: toFrac(n(irr, 'organicGrowth')) || 0,
    exitMult: n(irr, 'exitMultiple') || 20,
    horizon: n(irr, 'horizon') || 5,
    hurdle: toFrac(hurdle),
    de: toFrac(n(irr, 'deRatio') || n(irr, 'dCapital')) || 0,
    netBorrowCost: toFrac(n(irr, 'netBorrowCost')) || 0,
    // Moat
    rvPerShare: n(rv, 'rvPerShare') || 0,
    badge: (payload.thesisSummary && payload.thesisSummary.badge) || 'Conditional',
    funnelStage: 'research',       // published dashboards land in In Research
    _published: true,              // marker so frontend can gate 🌐
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = await requireRole(req, ['admin', 'analyst', 'any']);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const rows = await sbSelect(
      'company_dashboards',
      'select=ticker,dashboard_json&is_latest=is.true'
    );
    const out = [];
    (rows || []).forEach(r => {
      const row = synthRow(r.dashboard_json || {});
      if (row) out.push(row);
    });
    return res.status(200).json({ rows: out });
  } catch (e) {
    console.error('dashboard-universe-rows error', e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
};
