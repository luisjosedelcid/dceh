// POST /api/admin/run-cron
// Body: { name: 'price-alerts' | 'earnings-alerts' | 'premortem-eval' | 'watchlist-check' | ... }
// Auth: admin-only (x-admin-token)
// Invokes the cron handler in-process, bypassing the CRON_SECRET check by
// synthesizing the x-vercel-cron-schedule header the crons already accept.
//
// Purpose: manual smoke-testing and one-off re-runs without needing CRON_SECRET.

'use strict';

const path = require('path');
const { requireCapability } = require('../_require-capability');

const ALLOWED = new Set([
  'price-alerts',
  'earnings-alerts',
  'earnings-refresh',
  'premortem-eval',
  'portfolio-snapshot',
  'prices-refresh',
  'watchlist-check',
  'ingest-docs',
  'refresh-feed',
  'journal-reviews',
  'screener-refresh',
]);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const auth = await requireCapability(req, 'SY-02');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = await readJson(req);
    const name = body && body.name;
    if (!name || !ALLOWED.has(name)) {
      res.status(400).json({ error: 'name must be one of: ' + Array.from(ALLOWED).join(', ') });
      return;
    }
    const modPath = path.join(__dirname, '..', 'cron', `${name}.js`);
    let handler;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      handler = require(modPath);
    } catch (e) {
      res.status(500).json({ error: 'Cannot load cron', detail: String(e.message || e).slice(0, 200) });
      return;
    }

    // Synthesize a fake request that satisfies the cron's auth check
    // (crons accept `x-vercel-cron-schedule` presence as valid).
    const fakeReq = {
      method: 'GET',
      headers: {
        ...req.headers,
        'x-vercel-cron-schedule': 'manual-admin-trigger',
        // Also pass CRON_SECRET if present so the cron accepts either path.
        ...(process.env.CRON_SECRET ? { 'authorization': `Bearer ${process.env.CRON_SECRET}` } : {}),
      },
    };

    // Capture the cron's response
    let statusCode = 200;
    let responseBody = null;
    const fakeRes = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(v) { responseBody = v; return this; },
      end(v) { if (responseBody == null) { try { responseBody = JSON.parse(v); } catch { responseBody = v; } } return this; },
    };

    const started = Date.now();
    await handler(fakeReq, fakeRes);
    const elapsed = Date.now() - started;

    res.status(200).json({
      ok: true,
      cron: name,
      elapsed_ms: elapsed,
      inner_status: statusCode,
      inner_response: responseBody,
      triggered_by: auth.user.email,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 300) });
  }
};
