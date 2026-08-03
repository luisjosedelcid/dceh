// ═══════════════════════════════════════════════════════════════════
// Decision Journal → Data Room mirror
// ───────────────────────────────────────────────────────────────────
// After a decision_journal row is created, generate the same PDF the
// analyst can download on demand (via /api/decision-pdf) and archive
// a copy under Data Room ▸ Decision Journal ▸ <subfolder>.
//
// Routing map (decision_type → subfolder):
//   BUY, ADD                → Invested
//   SELL, TRIM              → Invested         (still a position event)
//   HOLD                    → Invested         (informational, keep with position)
//   FOLLOW                  → Followed
//   PASS                    → Passed
//
// The Re-Underwriting and Lessons Learned subfolders are populated by
// separate flows (reunderwriting-pdf, post-mortem) — NOT by this mirror.
//
// This module never throws in a way that would break the primary
// journal-create insert; on failure it returns { ok:false, error }.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbInsert } = require('./_supabase');

// Cached folder-id lookup so repeated writes don't re-query.
let _folderCache = null;
async function loadDecisionJournalFolders() {
  if (_folderCache) return _folderCache;
  const rows = await sbSelect(
    'dataroom_folders',
    `select=id,name,parent_id`
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  const root = rows.find(r => r.name === 'Decision Journal' && r.parent_id === null);
  if (!root) throw new Error('Decision Journal root folder not found');
  const bySubName = {};
  for (const r of rows) {
    if (r.parent_id === root.id) bySubName[r.name] = r.id;
  }
  _folderCache = { root, bySubName, byId };
  return _folderCache;
}

function subfolderForDecision(decisionType) {
  const t = String(decisionType || '').toUpperCase();
  if (t === 'BUY' || t === 'ADD' || t === 'SELL' || t === 'TRIM' || t === 'HOLD') return 'Invested';
  if (t === 'FOLLOW') return 'Followed';
  if (t === 'PASS') return 'Passed';
  return null;
}

function detectMimeFor(filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  return ext.toLowerCase() === 'pdf' ? 'application/pdf' : 'application/octet-stream';
}

// Uploads a buffer to the 'dataroom' Storage bucket and inserts the
// dataroom_files row. Returns { ok:true, item } or { ok:false, error }.
async function uploadPdfToDataroom({ folderId, filename, displayName, buffer, detail, actor }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: 'Supabase credentials not configured' };
  }
  const ts = Math.floor(Date.now() / 1000);
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  const storagePath = `${folderId}/${ts}__${safeName}`;
  const mime = detectMimeFor(safeName);

  const shownName = displayName || safeName;
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/dataroom/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': mime,
        'x-upsert': 'false',
      },
      body: buffer,
    }
  );
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    return { ok: false, error: `Storage upload failed: ${uploadRes.status} ${text.slice(0, 200)}` };
  }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/dataroom/${storagePath}`;
  try {
    const result = await sbInsert('dataroom_files', {
      folder_id: folderId,
      name: shownName,
      filename: safeName,
      storage_path: storagePath,
      url: publicUrl,
      size_bytes: buffer.length,
      mime_type: mime,
      detail: detail || null,
      uploaded_by: actor || 'system',
    });
    const item = Array.isArray(result) ? result[0] : result;
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: `Metadata insert failed: ${String(e).slice(0, 200)}`, url: publicUrl };
  }
}

// mirrorDecisionToDataroom(entryId, adminToken, actor)
// ---------------------------------------------------------------------------
// Self-fetches /api/decision-pdf using the caller's admin token to reproduce
// the exact PDF the analyst downloads, then archives it into the correct
// Decision Journal subfolder based on the decision type.
async function mirrorDecisionToDataroom({ entryId, adminToken, actor, decisionType, ticker, decisionDate }) {
  try {
    const subName = subfolderForDecision(decisionType);
    if (!subName) return { ok: false, error: `No subfolder for decision_type=${decisionType}` };

    const folders = await loadDecisionJournalFolders();
    const folderId = folders.bySubName[subName];
    if (!folderId) return { ok: false, error: `Subfolder '${subName}' not found under Decision Journal` };

    // Build the absolute base URL. On Vercel serverless, VERCEL_URL is the
    // deployment hostname without protocol. Locally, DCE_APP_ORIGIN can be
    // set for dev. As a fallback for background/cron contexts we accept
    // DCE_APP_ORIGIN from env.
    const base =
      process.env.DCE_APP_ORIGIN ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    if (!base) return { ok: false, error: 'No base URL: set DCE_APP_ORIGIN or run on Vercel' };

    const pdfRes = await fetch(
      `${base}/api/decision-pdf?id=${encodeURIComponent(entryId)}`,
      { headers: { 'x-admin-token': adminToken } }
    );
    if (!pdfRes.ok) {
      const text = await pdfRes.text().catch(() => '');
      return { ok: false, error: `decision-pdf fetch failed: ${pdfRes.status} ${text.slice(0, 200)}` };
    }
    const arrayBuf = await pdfRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length < 500) {
      return { ok: false, error: `decision-pdf returned suspiciously small body (${buffer.length} bytes)` };
    }

    const dateCompact = String(decisionDate || '').replace(/-/g, '');
    // filename = storage-safe, machine-readable; displayName = what the UI shows
    const filename = `Decision_${ticker}_${String(decisionType).toUpperCase()}_${dateCompact}.pdf`;
    const displayName = `${ticker} — ${String(decisionType).toUpperCase()} — ${decisionDate}.pdf`;
    const detail = `Auto-archived decision PDF (entry #${entryId})`;

    const upload = await uploadPdfToDataroom({
      folderId, filename, displayName, buffer, detail, actor,
    });
    if (!upload.ok) return { ok: false, error: upload.error, url: upload.url };
    return { ok: true, folder: subName, file: upload.item };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = {
  mirrorDecisionToDataroom,
  subfolderForDecision,
  loadDecisionJournalFolders,
};
