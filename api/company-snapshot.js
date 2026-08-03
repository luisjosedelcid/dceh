// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Company Snapshot endpoint
// ───────────────────────────────────────────────────────────────────
//   POST /api/company-snapshot { ticker }
//     Generates a branded 1-page PDF snapshot from ROIC.ai fundamentals,
//     uploads to the `dataroom` Storage bucket under the "Company
//     Snapshots" subfolder, creates a dataroom_files row, and returns
//     { ok, file_id, url, storage_path }.
//
//   GET /api/company-snapshot?ticker=UBER
//     Returns the newest snapshot for a ticker if one exists:
//       { ok:true, exists:true, file_id, url, name, created_at }
//     or { ok:true, exists:false } if none has been generated yet.
//
// Auth: admin only. Idempotency: caller decides — GET first, then POST
// if missing.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { verifyAdminToken } = require('./_admin-auth');
const { sbSelect, sbInsert } = require('./_supabase');
const { buildCompanySnapshotPDF } = require('./_company-snapshot-pdf');

// The subfolder ID is resolved dynamically the first time we need it
// (created below if absent).
let CACHED_FOLDER_ID = null;

function requireAuth(req, res) {
  const tok = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!tok || !secret) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return null;
  }
  const v = verifyAdminToken(tok, secret);
  if (!v) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return null;
  }
  return v.email || 'admin';
}

async function ensureCompanySnapshotsFolder() {
  if (CACHED_FOLDER_ID) return CACHED_FOLDER_ID;
  // The Research root folder is named "06 Research" in DCE's Data Room
  // taxonomy. Match by ILIKE '%Research%' at the root level (parent_id
  // is null) to be resilient to numbering changes.
  const research = await sbSelect(
    'dataroom_folders',
    `select=id,name&parent_id=is.null&name=ilike.%25Research%25&limit=5`
  );
  if (!research || research.length === 0) {
    throw new Error('Cannot locate Research root folder in dataroom_folders');
  }
  const researchId = research[0].id;
  // Look for existing Company Snapshots subfolder under Research
  const existing = await sbSelect(
    'dataroom_folders',
    `select=id,name,parent_id&parent_id=eq.${researchId}&name=eq.Company%20Snapshots&limit=1`
  );
  if (existing && existing.length > 0) {
    CACHED_FOLDER_ID = existing[0].id;
    return CACHED_FOLDER_ID;
  }
  // Create it
  const ins = await sbInsert('dataroom_folders', {
    name: 'Company Snapshots',
    parent_id: researchId,
  });
  const row = Array.isArray(ins) ? ins[0] : ins;
  CACHED_FOLDER_ID = row.id;
  return CACHED_FOLDER_ID;
}

async function findExistingSnapshot(ticker) {
  const t = String(ticker).toUpperCase();
  const folderId = await ensureCompanySnapshotsFolder();
  // Newest first, matching by filename prefix
  const prefix = `Company_Snapshot_${t}_`;
  const rows = await sbSelect(
    'dataroom_files',
    `select=id,name,filename,storage_path,created_at&folder_id=eq.${folderId}&filename=ilike.${encodeURIComponent(prefix)}*&order=created_at.desc&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0];
}

function publicUrl(storagePath) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/dataroom/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
}

async function uploadToStorage(buffer, storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/dataroom/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'x-upsert': 'true',
      'Content-Type': 'application/pdf',
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
    if (req.method === 'GET') {
      const actor = requireAuth(req, res);
      if (!actor) return;
      const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
      const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) {
        return res.status(400).end(JSON.stringify({ ok: false, error: 'Invalid ticker' }));
      }
      const existing = await findExistingSnapshot(ticker);
      if (!existing) return res.status(200).end(JSON.stringify({ ok: true, exists: false }));
      return res.status(200).end(JSON.stringify({
        ok: true,
        exists: true,
        file_id: existing.id,
        name: existing.name,
        url: publicUrl(existing.storage_path),
        created_at: existing.created_at,
      }));
    }

    if (req.method === 'POST') {
      const actor = requireAuth(req, res);
      if (!actor) return;

      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      const ticker = String(body.ticker || '').toUpperCase().trim();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) {
        return res.status(400).end(JSON.stringify({ ok: false, error: 'Invalid ticker' }));
      }

      // Build PDF
      let buffer;
      try {
        const built = await buildCompanySnapshotPDF(ticker);
        buffer = built.buffer;
      } catch (e) {
        return res.status(502).end(JSON.stringify({ ok: false, error: `roic.ai error: ${e.message}` }));
      }

      // Upload
      const folderId = await ensureCompanySnapshotsFolder();
      const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const filename = `Company_Snapshot_${ticker}_${ts}.pdf`;
      const displayName = `${ticker} — Company Snapshot — ${new Date().toISOString().slice(0,10)}.pdf`;
      const storagePath = `${folderId}/${Date.now()}__${filename}`;

      await uploadToStorage(buffer, storagePath);

      const inserted = await sbInsert('dataroom_files', {
        folder_id: folderId,
        name: displayName,
        filename,
        storage_path: storagePath,
        url: publicUrl(storagePath),
        size_bytes: buffer.length,
        mime_type: 'application/pdf',
        detail: 'company_snapshot',
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
      }));
    }

    return res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  } catch (e) {
    console.error('company-snapshot error:', e.message, e.stack?.slice(0, 400));
    return res.status(500).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
