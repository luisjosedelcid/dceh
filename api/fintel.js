// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Fintel API Proxy (Vercel serverless function)
// ───────────────────────────────────────────────────────────────────
// Auth (any of):
//   1. x-admin-token  — verified against ADMIN_TOKEN_SECRET (preferred,
//      issued by /api/admin-login and stored as dce_admin_token in
//      localStorage by dce-auth.js)
//   2. x-dashboard-auth === DASHBOARD_PASSWORD (legacy, kept for backwards
//      compat with any embedded clients that still use it)
//
// Required env vars:
//   FINTEL_API_KEY      — Fintel Silver tier key (sk_...)
//   ADMIN_TOKEN_SECRET  — secret used by admin-login to sign tokens
//   DASHBOARD_PASSWORD  — legacy gate password (optional)
//
// Client usage (from /screener.html Superinvestors tab):
//   fetch('/api/fintel?endpoint=/web/v/0.0/i/berkshire-hathaway',
//         { headers: { 'x-admin-token': adminToken } })
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('./_admin-auth');

// Whitelist of allowed Fintel path prefixes — prevents arbitrary proxying
const ALLOWED_PREFIXES = [
  '/web/v/0.0/i/',          // Fund holdings (13F)
  '/web/v/0.0/so/',         // Stock ownership / owner history
  '/web/v/0.0/n/',          // Insider trades
  '/web/v/0.0/ss/',         // Short interest
  '/data/v/0.0/i/',         // Premium fund holdings
  '/data/v/0.0/so/',        // Premium owner history
];

module.exports = async function handler(req, res) {
  // CORS / preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-auth, x-admin-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth: prefer admin token; fall back to legacy dashboard password ──
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  const adminTok = req.headers['x-admin-token'];
  const dashAuth = req.headers['x-dashboard-auth'];

  let authed = false;
  if (adminTok && ADMIN_TOKEN_SECRET && verifyAdminToken(adminTok, ADMIN_TOKEN_SECRET)) {
    authed = true;
  } else if (dashAuth && process.env.DASHBOARD_PASSWORD && dashAuth === process.env.DASHBOARD_PASSWORD) {
    authed = true;
  }
  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const endpoint = req.query.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Missing endpoint query param' });
  }

  // Whitelist check
  const allowed = ALLOWED_PREFIXES.some(p => endpoint.startsWith(p));
  if (!allowed) {
    return res.status(400).json({ error: 'Endpoint not whitelisted', endpoint });
  }

  if (!process.env.FINTEL_API_KEY) {
    return res.status(500).json({ error: 'FINTEL_API_KEY not configured' });
  }

  try {
    const url = `https://api.fintel.io${endpoint}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-KEY': process.env.FINTEL_API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; DCEHoldings/1.0; +https://dceholdings.app)',
      },
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: 'Non-JSON response', body: text.slice(0, 500) }; }

    if (!response.ok) {
      console.error('Fintel error:', response.status, JSON.stringify(data).slice(0, 300));
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(response.ok ? 200 : response.status).json(data);

  } catch (error) {
    console.error('Fintel proxy error:', error.message);
    return res.status(500).json({ error: 'Proxy error', detail: error.message });
  }
};
