// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Company Snapshot v2 PREVIEW endpoint
// ───────────────────────────────────────────────────────────────────
//   POST /api/company-snapshot-preview  { ticker }
//     Builds a v2 snapshot PDF using the new spec (factual, 1-page,
//     ROIC.ai only), uploads it to a dedicated "Company Snapshots
//     (Preview)" subfolder in the Data Room, and returns { ok, url,
//     pages, storage_path }.
//
//   Non-destructive: does NOT touch the current production
//     /api/company-snapshot. Once approved, prod builder is swapped
//     for v2 and this endpoint can be retired.
//
// Auth: admin only.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect, sbInsert } = require('./_supabase');
const { buildCompanySnapshotPDFv2 } = require('./_company-snapshot-pdf-v2');

let CACHED_FOLDER_ID = null;

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) { res.status(401).json({ ok:false, error:'Unauthorized' }); return null; }
  const v = verifyAdminToken(tok, secret);
  if (!v) { res.status(401).json({ ok:false, error:'Unauthorized' }); return null; }
  return v.email || 'admin';
}

async function ensurePreviewFolder() {
  if (CACHED_FOLDER_ID) return CACHED_FOLDER_ID;
  const research = await sbSelect(
    'dataroom_folders',
    `select=id,name&parent_id=is.null&name=ilike.%25Research%25&order=name.asc&limit=5`
  );
  if (!research || research.length === 0) throw new Error('Cannot locate Research root folder');
  const preferred = research.find(r => /^06\s+Research$/i.test(r.name || ''))
    || research.find(r => /Research$/i.test(r.name || ''))
    || research[0];
  const researchId = preferred.id;

  const existing = await sbSelect(
    'dataroom_folders',
    `select=id,name,parent_id&parent_id=eq.${researchId}&name=eq.Company%20Snapshots%20(Preview)&limit=1`
  );
  if (existing && existing.length > 0) {
    CACHED_FOLDER_ID = existing[0].id;
    return CACHED_FOLDER_ID;
  }
  const ins = await sbInsert('dataroom_folders', {
    name: 'Company Snapshots (Preview)',
    slug: 'company-snapshots-preview',
    parent_id: researchId,
    order_index: 101,
    is_system: false,
    created_by: 'system',
  });
  const row = Array.isArray(ins) ? ins[0] : ins;
  CACHED_FOLDER_ID = row.id;
  return CACHED_FOLDER_ID;
}

function publicUrl(storagePath) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/dataroom/${storagePath}`;
}

async function uploadToStorage(buffer, storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error('Supabase credentials not configured');
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/dataroom/${storagePath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'apikey': KEY,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Storage upload ${r.status}: ${t.slice(0,300)}`);
  }
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  try {
    if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));
    const actor = requireAuth(req, res);
    if (!actor) return;

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const ticker = String(body.ticker || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return res.status(400).end(JSON.stringify({ ok:false, error:'Invalid ticker' }));

    let built;
    try { built = await buildCompanySnapshotPDFv2(ticker); }
    catch (e) { return res.status(502).end(JSON.stringify({ ok:false, error:`roic.ai error: ${e.message}` })); }

    const folderId = await ensurePreviewFolder();
    const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const filename = `Company_Snapshot_v2_${ticker}_${ts}.pdf`;
    const displayName = `${ticker} — Company Snapshot v2 — ${new Date().toISOString().slice(0,10)}.pdf`;
    const storagePath = `${folderId}/${Date.now()}__${filename}`;

    await uploadToStorage(built.buffer, storagePath);

    const inserted = await sbInsert('dataroom_files', {
      folder_id: folderId,
      name: displayName,
      filename,
      storage_path: storagePath,
      url: publicUrl(storagePath),
      size_bytes: built.buffer.length,
      mime_type: 'application/pdf',
      detail: 'company_snapshot_preview',
      uploaded_by: actor,
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return res.status(200).end(JSON.stringify({
      ok: true,
      file_id: row?.id || null,
      name: displayName,
      filename,
      url: publicUrl(storagePath),
      storage_path: storagePath,
      pages: built.pages,
    }));
  } catch (e) {
    console.error('company-snapshot-preview error:', e.message, e.stack?.slice(0, 400));
    return res.status(500).end(JSON.stringify({ ok:false, error:e.message }));
  }
};
