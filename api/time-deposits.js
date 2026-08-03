// GET  /api/time-deposits            → list all deposits + valued snapshot as of today
// GET  /api/time-deposits?as_of=YYYY → snapshot at a specific date
// POST /api/time-deposits            → create a new deposit (admin token required)
//
// Auth: mirrors /api/performance behaviour (admin token).

const { loadAndValueTimeDeposits } = require('./_time-deposits');
const { sbInsert } = require('./_supabase');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true; // dev / no-auth mode
  const t = req.headers['x-admin-token'] || '';
  return t === ADMIN_TOKEN;
}

async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!isAdmin(req)) {
        res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const url = new URL(req.url, 'http://x');
      const asOf = url.searchParams.get('as_of') || undefined;
      const result = await loadAndValueTimeDeposits(asOf);
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.status(200).end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    if (req.method === 'POST') {
      if (!isAdmin(req)) {
        res.status(401).end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      // Parse body
      const body = await new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
      });

      // Validate required fields
      const required = ['name', 'principal', 'start_date', 'maturity_date', 'annual_rate'];
      for (const k of required) {
        if (body[k] == null || body[k] === '') {
          res.status(400).end(JSON.stringify({ ok: false, error: `Missing field: ${k}` }));
          return;
        }
      }

      const principal = Number(body.principal);
      const annualRate = Number(body.annual_rate);
      const taxRate = Number(body.tax_rate || 0);
      if (!Number.isFinite(principal) || principal <= 0) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'principal must be > 0' }));
        return;
      }
      if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'annual_rate must be a decimal (e.g. 0.0725 for 7.25%)' }));
        return;
      }
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'tax_rate must be a decimal (e.g. 0.10 for 10%)' }));
        return;
      }
      if (body.start_date >= body.maturity_date) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'maturity_date must be after start_date' }));
        return;
      }

      const row = {
        name: String(body.name),
        bank: body.bank ? String(body.bank) : null,
        currency: body.currency || 'USD',
        principal,
        start_date: body.start_date,
        maturity_date: body.maturity_date,
        annual_rate: annualRate,
        tax_rate: taxRate,
        day_count_convention: body.day_count_convention || 'actual_365',
        payment_frequency: body.payment_frequency || 'bullet',
        status: 'active',
        notes: body.notes ? String(body.notes) : null,
        source: 'manual',
        external_id: body.external_id || null,
      };

      const inserted = await sbInsert('time_deposits', [row]);
      res.setHeader('content-type', 'application/json');
      res.status(200).end(JSON.stringify({ ok: true, inserted }));
      return;
    }

    res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

module.exports = handler;
