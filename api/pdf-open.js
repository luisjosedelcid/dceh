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

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(process.cwd(), 'public', 'docs');
const BUCKET   = 'reports';
const PREFIX   = 'proxy';   // reports/proxy/<filename>

async function objectExists(baseUrl, key, objectPath) {
  const r = await fetch(`${baseUrl}/storage/v1/object/info/${BUCKET}/${objectPath}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  return r.status === 200;
}

async function uploadObject(baseUrl, key, objectPath, buffer, mime) {
  const url = `${baseUrl}/storage/v1/object/${BUCKET}/${objectPath}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
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

    // Verify the file exists in /public/docs/
    const localPath = path.join(DOCS_DIR, filename);
    if (!localPath.startsWith(DOCS_DIR)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    let stat;
    try {
      stat = fs.statSync(localPath);
    } catch (e) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      // If Supabase is not configured, fall back to same-origin.
      // Desktop will still work; PWA standalone loses the Back button
      // but at least the document loads.
      res.writeHead(302, { Location: `/docs/${encodeURIComponent(filename)}` });
      res.end();
      return;
    }

    // Object key on Supabase: proxy/<filename>. Idempotent — if the
    // local file's mtime is newer than the cache, we re-upload; else
    // we skip. Cheap ETag: include mtime in the key.
    const mtime = Math.floor(stat.mtimeMs / 1000);
    const objectPath = `${PREFIX}/${mtime}__${filename}`;
    const publicUrl  = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    // If it already exists on Supabase, redirect immediately.
    const exists = await objectExists(SUPABASE_URL, SUPABASE_KEY, objectPath);
    if (!exists) {
      const buffer = fs.readFileSync(localPath);
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
    // Last-resort fallback: try same-origin
    console.error('pdf-open failed', err);
    const raw = (req.query && req.query.path) ? String(req.query.path) : '';
    let filename = raw.trim();
    if (filename.startsWith('/docs/')) filename = filename.slice('/docs/'.length);
    res.writeHead(302, { Location: `/docs/${encodeURIComponent(filename)}` });
    res.end();
  }
};
