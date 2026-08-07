// Serve the active dashboard_html for a given ticker.
// GET /api/dashboard-view?ticker=MSFT2  → HTML response
//
// This is the "publish to Universe" render endpoint. It picks the
// latest active dashboard_html row across all pipeline_cards matching
// the ticker (case-insensitive) and streams the file inline.
//
// Access: requires a valid admin/analyst token (via x-admin-token header
// OR ?token= query param, so <a href> from Universe works without headers).

const { requireCapability } = require('./_require-capability');
const { sbSelect } = require('./_supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'pipeline-assets';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Support token via query param (for anchor links) or header.
  const qToken = req.query.token;
  if (qToken && !req.headers['x-admin-token']) {
    req.headers['x-admin-token'] = qToken;
  }

  const auth = await requireCapability(req, 'DB-01');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const ticker = (req.query.ticker || '').toString().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

  try {
    // Match ticker case-insensitively, prefer most recent
    const rows = await sbSelect(
      'pipeline_card_assets',
      `ticker=ilike.${encodeURIComponent(ticker)}&kind=eq.dashboard_html&active=eq.true&select=storage_path,filename,uploaded_at&order=uploaded_at.desc&limit=1`
    );
    if (!rows.length) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not found</title>
<style>body{font-family:Calibri,Arial,sans-serif;background:#F5F1EB;color:#1B2642;padding:60px;text-align:center}
h1{font-weight:300;font-size:28px}.g{color:#B88B47;font-weight:600}</style></head><body>
<h1>No dashboard published for <span class="g">${ticker.replace(/[<>&"']/g,'')}</span></h1>
<p style="color:#606060;margin-top:12px">Upload an Excel + Company Brief in the research pipeline and click Generate Dashboard.</p>
</body></html>`);
    }
    const row = rows[0];

    // Stream from Supabase Storage
    const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${row.storage_path}`;
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Storage fetch failed: ${r.status}` });
    }
    const html = await r.text();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).send(html);
  } catch (e) {
    console.error('dashboard-view error', e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
};
