// api/pdf-open.js
//
// Same-origin PDF proxy that mirrors /public/docs/*.pdf to Supabase
// Storage on first hit, then 302-redirects to the public Supabase URL.
//
// Why: in the installed PWA (iPad Mini / iPhone in standalone mode),
// same-origin PDFs render inside the app window with no browser chrome,
// no Back button, and no way to close short of quitting the app. But
// any *cross-origin* URL triggers iOS's native QuickLook viewer with a
// close (X) button and "1 de N" pagination — the exact experience that
// the screener's /api/company-snapshot already delivers because its
// output is hosted on Supabase.
//
// Rather than migrate every /docs/*.pdf to Supabase, this endpoint acts
// as a thin proxy: read the local file, upload it to the `reports`
// bucket under the `proxy/` prefix (idempotent via HEAD check), and
// redirect to the public Supabase URL. Desktop browsers behave exactly
// the same — a cross-origin PDF opens in the browser's native PDF
// viewer with normal Back navigation.
//
// Usage from the frontend:
//   <a href="/api/pdf-open?path=DCE_LULU_Valuation_Report.pdf" target="_blank">
//
// Only files inside /public/docs/ are exposed. Path traversal is
// blocked. Only .pdf is accepted.

// Vercel serverless functions cannot read /public/* directly, so we
// fetch the PDF over HTTP against our own origin instead of reading it
// from disk. Origin is derived from the request host.
const BUCKET = 'reports';
const PREFIX = 'proxy';   // reports/proxy/<mtime>__<filename>

async function objectExists(baseUrl, key, objectPath) {
  const r = await fetch(`${baseUrl}/storage/v1/object/info/${BUCKET}/${objectPath}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey':        key,
    },
  });
  return r.status === 200;
}

async function uploadObject(baseUrl, key, objectPath, buffer, mime) {
  const url = `${baseUrl}/storage/v1/object/${BUCKET}/${objectPath}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey':        key,
      'Content-Type':  mime || 'application/pdf',
      'x-upsert':      'true',
      'Cache-Control': '3600',
    },
    body: buffer,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`upload failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json().catch(() => ({}));
}

module.exports = async function handler(req, res) {
  try {
    // Only GET
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const raw = req.query && req.query.path ? String(req.query.path) : '';
    if (!raw) {
      res.status(400).json({ error: 'Missing ?path' });
      return;
    }

    // Accept absolute-style '/docs/xxx.pdf' or bare 'xxx.pdf'
    let filename = raw.trim();
    if (filename.startsWith('/docs/')) filename = filename.slice('/docs/'.length);
    if (filename.startsWith('docs/'))  filename = filename.slice('docs/'.length);

    // Reject path traversal or nested paths
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    // Only .pdf files
    if (!/\.pdf$/i.test(filename)) {
      res.status(400).json({ error: 'Only .pdf is supported' });
      return;
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      // No Supabase env — fall back to same-origin. Desktop still works;
      // PWA standalone loses QuickLook but at least the doc loads.
      res.writeHead(302, { Location: `/docs/${encodeURIComponent(filename)}` });
      res.end();
      return;
    }

    // Determine our own origin from the request headers. In production
    // this is https://www.dceholdings.app; on preview deployments it
    // is the auto-generated *.vercel.app hostname.
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host  = (req.headers['x-forwarded-host']  || req.headers.host || 'www.dceholdings.app').split(',')[0].trim();
    const originUrl = `${proto}://${host}/docs/${encodeURIComponent(filename)}`;

    // Fetch the PDF from our own static origin (Vercel serves /public/).
    // Use HEAD first to grab Last-Modified for our cache key, then GET.
    let headRes;
    try {
      headRes = await fetch(originUrl, { method: 'HEAD' });
    } catch (e) {
      res.status(502).json({ error: 'origin fetch failed', detail: String(e) });
      return;
    }
    if (!headRes.ok) {
      res.status(404).json({ error: 'Document not found on origin' });
      return;
    }

    // Cheap ETag: use Last-Modified epoch (falls back to a stable
    // fingerprint so re-generated PDFs still bust the cache).
    const lm = headRes.headers.get('last-modified');
    const et = headRes.headers.get('etag') || '';
    const stamp = lm
      ? Math.floor(new Date(lm).getTime() / 1000)
      : (et.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'v1');

    const objectPath = `${PREFIX}/${stamp}__${filename}`;
    const publicUrl  = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    // If already on Supabase, redirect immediately.
    const exists = await objectExists(SUPABASE_URL, SUPABASE_KEY, objectPath);
    if (!exists) {
      const getRes = await fetch(originUrl);
      if (!getRes.ok) {
        res.status(502).json({ error: 'origin GET failed', status: getRes.status });
        return;
      }
      const ab = await getRes.arrayBuffer();
      const buffer = Buffer.from(ab);
      await uploadObject(SUPABASE_URL, SUPABASE_KEY, objectPath, buffer, 'application/pdf');
    }

    // Redirect the browser to the cross-origin Supabase URL. In the iOS
    // PWA standalone this triggers the native QuickLook viewer with a
    // close (X) button; on desktop it opens in the browser's PDF viewer.
    res.writeHead(302, {
      Location:      publicUrl,
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch (err) {
    // Surface failures as JSON so we can diagnose from the browser or curl
    // instead of silently redirecting back to same-origin (which strands the
    // iPad Mini PWA user again).
    console.error('pdf-open failed', err);
    res.status(500).json({
      error:  'pdf-open failed',
      detail: (err && err.message) || String(err),
    });
  }
};
