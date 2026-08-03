// GET  /api/time-deposits            → list all deposits + valued snapshot as of today
// GET  /api/time-deposits?as_of=YYYY → snapshot at a specific date
// POST /api/time-deposits            → create a new deposit (admin only)
//
// Auth: mirrors /api/performance (HMAC admin token via requireRole).

const { loadAndValueTimeDeposits } = require('./_time-deposits');
const { sbInsert } = require('./_supabase');
const { requireRole } = require('./_require-role');

function parseBody(req) {
  // Vercel usually parses JSON into req.body already. Prefer that, then fall
  // back to reading the raw stream (local / mocked servers).
  return new Promise((resolve, reject) => {
    if (req.body != null) {
      if (typeof req.body === 'string') {
        try { resolve(req.body ? JSON.parse(req.body) : {}); }
        catch (e) { reject(e); }
        return;
      }
      if (typeof req.body === 'object') { resolve(req.body); return; }
    }
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  try {
    // GET: any authenticated user (same bar as /api/performance).
    // POST: admin only — creates portfolio capital rows.
    const allowed = req.method === 'GET' ? ['any'] : ['admin'];
    const auth = await requireRole(req, allowed);
    if (!auth.ok) {
      res.setHeader('content-type', 'application/json');
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const asOf = url.searchParams.get('as_of') || undefined;
      const result = await loadAndValueTimeDeposits(asOf);
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.status(200).end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);

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
