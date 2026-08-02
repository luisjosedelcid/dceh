// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Pipeline assets ↔ Data Room mirror
// ───────────────────────────────────────────────────────────────────
// Auto-mirrors pipeline_card_assets → dataroom_files so analyst uploads
// in the research board also show up under Data Room → 06 Research.
//
// Design:
//   - Physical bytes live in the `pipeline-assets` private bucket.
//   - dataroom_files.storage_path stores the SAME path (with a bucket
//     prefix `pipeline-assets/`) so the Data Room signed-URL flow
//     resolves it via the bucket router in dataroom-uploaded-files.
//   - Link established with mirror_id (uuid) on both rows.
//   - Soft-delete on the pipeline side removes the dataroom row.
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { randomUUID } = require('crypto');
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require('./_supabase');

const PIPELINE_FOLDER_ID = '1b7cc399-9b99-43a8-a6d3-9a61058ea427'; // 06 Research

// Copy a file from the pipeline-assets bucket into the dataroom bucket.
// Returns the new path in the dataroom bucket, or null on failure.
async function copyToDataroomBucket(pipelinePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return null;
  // Read from source
  const srcUrl = `${SUPABASE_URL}/storage/v1/object/pipeline-assets/${pipelinePath.split('/').map(encodeURIComponent).join('/')}`;
  const srcRes = await fetch(srcUrl, {
    headers: { 'Authorization': `Bearer ${KEY}`, 'apikey': KEY },
  });
  if (!srcRes.ok) throw new Error(`Source read failed: ${srcRes.status}`);
  const buf = Buffer.from(await srcRes.arrayBuffer());
  const mime = srcRes.headers.get('content-type') || 'application/octet-stream';
  // Write to dest
  const destPath = `pipeline_mirror/${pipelinePath}`;
  const dstUrl = `${SUPABASE_URL}/storage/v1/object/dataroom/${destPath.split('/').map(encodeURIComponent).join('/')}`;
  const dstRes = await fetch(dstUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'apikey': KEY,
      'Content-Type': mime,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!dstRes.ok) {
    const t = await dstRes.text().catch(() => '');
    throw new Error(`Dest write failed: ${dstRes.status} ${t.slice(0, 200)}`);
  }
  return destPath;
}

const KIND_LABEL = {
  excel:               'Columbia Model',
  company_brief_pdf:   'Company Brief',
  thesis_builder_pdf:  'Thesis Builder',
  thesis_breaker_pdf:  'Thesis Breaker',
  munger_digital_pdf:  'Munger Digital',
  dashboard_html:      'Dashboard',
};

/**
 * Mirror a pipeline_card_assets row into dataroom_files.
 * Idempotent per mirror_id. Returns the mirror_id used.
 */
async function mirrorPipelineToDataroom(pipelineRow) {
  if (!pipelineRow || !pipelineRow.id) return null;

  // Ensure mirror_id on the pipeline row
  let mid = pipelineRow.mirror_id;
  if (!mid) {
    mid = randomUUID();
    await sbUpdate('pipeline_card_assets', `id=eq.${pipelineRow.id}`, { mirror_id: mid });
  }

  // Skip if already mirrored
  const existing = await sbSelect('dataroom_files', `select=id&mirror_id=eq.${mid}&limit=1`);
  if (existing.length) return mid;

  const ticker = String(pipelineRow.ticker || 'UNKN').toUpperCase();
  const label = KIND_LABEL[pipelineRow.kind] || pipelineRow.kind || 'File';
  const displayName = `${ticker} — ${label}`;

  // Physically copy the object into the dataroom bucket so the standard
  // Data Room signed-URL flow (bucket=dataroom) resolves it without changes.
  let dataroomPath;
  try {
    dataroomPath = await copyToDataroomBucket(pipelineRow.storage_path);
  } catch (e) {
    console.warn('copyToDataroomBucket failed:', e.message);
    return null;
  }
  if (!dataroomPath) return null;

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/dataroom/${dataroomPath.split('/').map(encodeURIComponent).join('/')}`;

  await sbInsert('dataroom_files', {
    folder_id: PIPELINE_FOLDER_ID,
    name: displayName,
    filename: pipelineRow.filename || `${ticker}_${pipelineRow.kind}`,
    storage_path: dataroomPath,
    url: publicUrl,
    size_bytes: pipelineRow.size_bytes || 0,
    mime_type: pipelineRow.mime_type || null,
    detail: `Auto-mirrored from research card (${ticker}).`,
    uploaded_by: pipelineRow.uploaded_by || null,
    mirror_id: mid,
  });
  return mid;
}

/**
 * Remove the mirrored dataroom row when the pipeline asset is deactivated.
 */
async function removeDataroomMirror(mirrorId) {
  if (!mirrorId) return false;
  const rows = await sbSelect('dataroom_files', `select=id,storage_path&mirror_id=eq.${mirrorId}&limit=1`);
  if (!rows.length) return false;
  const row = rows[0];
  // Best-effort remove storage object
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (SUPABASE_URL && KEY && row.storage_path) {
    try {
      await fetch(`${SUPABASE_URL}/storage/v1/object/dataroom/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${KEY}`, 'apikey': KEY },
      });
    } catch (e) { /* silent */ }
  }
  await sbDelete('dataroom_files', `mirror_id=eq.${mirrorId}`);
  return true;
}

module.exports = {
  PIPELINE_FOLDER_ID,
  mirrorPipelineToDataroom,
  removeDataroomMirror,
};
