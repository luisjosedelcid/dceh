// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Sector Briefs mirror between Study and Data Room
// ───────────────────────────────────────────────────────────────────
// Mirrors the "Sector" section in Study (study_files.section='sector')
// with the "Sector Briefs" folder in the Data Room (folder_id below).
//
// Design:
//   - Single physical object in whichever Storage bucket the upload
//     originated (study or dataroom).
//   - study_files.mirror_id === dataroom_files.mirror_id  (uuid) links the pair.
//   - Both rows share url + storage_path (of the origin bucket).
//   - On delete from either side, both rows and the Storage object go.
//   - On rename (name/detail) from either side, the sibling row is
//     also updated. (Not yet wired in the endpoints — first pass only
//     covers upload + delete + backfill.)
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { randomUUID } = require('crypto');
const { sbSelect, sbInsert, sbDelete, sbHeaders, sbBaseUrl } = require('./_supabase');

const SECTOR_BRIEFS_FOLDER_ID = '9d6aa2d9-70b9-47a9-9993-fc6291bc3ad0';

async function findMirror(mirrorId, table) {
  const rows = await sbSelect(table, `select=*&mirror_id=eq.${mirrorId}&limit=1`);
  return rows.length ? rows[0] : null;
}

async function ensureMirrorId(row, table) {
  if (row.mirror_id) return row.mirror_id;
  const id = randomUUID();
  const idField = 'id';
  const url = `${sbBaseUrl()}/rest/v1/${table}?${idField}=eq.${row.id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ mirror_id: id }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ensureMirrorId PATCH failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return id;
}

/**
 * Mirror a freshly uploaded study/sector row into dataroom_files.
 * Idempotent: if a mirror already exists for the given mirror_id, do nothing.
 * Returns the mirror_id used (creating one on the study row if missing).
 */
async function mirrorStudyToDataroom(studyRow) {
  if (studyRow.section !== 'sector') return null;
  const mid = await ensureMirrorId(studyRow, 'study_files');
  const existing = await findMirror(mid, 'dataroom_files');
  if (existing) return mid;
  await sbInsert('dataroom_files', {
    folder_id: SECTOR_BRIEFS_FOLDER_ID,
    name: studyRow.name,
    filename: studyRow.filename,
    storage_path: studyRow.storage_path,
    url: studyRow.url,
    size_bytes: studyRow.size_bytes,
    mime_type: studyRow.mime_type,
    detail: studyRow.detail || null,
    uploaded_by: studyRow.uploaded_by,
    mirror_id: mid,
  });
  return mid;
}

/**
 * Mirror a freshly uploaded dataroom row (Sector Briefs folder) into study_files.
 * Idempotent.
 */
async function mirrorDataroomToStudy(dataroomRow) {
  if (dataroomRow.folder_id !== SECTOR_BRIEFS_FOLDER_ID) return null;
  const mid = await ensureMirrorId(dataroomRow, 'dataroom_files');
  const existing = await findMirror(mid, 'study_files');
  if (existing) return mid;
  await sbInsert('study_files', {
    section: 'sector',
    name: dataroomRow.name,
    filename: dataroomRow.filename,
    storage_path: dataroomRow.storage_path,
    url: dataroomRow.url,
    size_bytes: dataroomRow.size_bytes,
    mime_type: dataroomRow.mime_type,
    detail: dataroomRow.detail || null,
    uploaded_by: dataroomRow.uploaded_by,
    mirror_id: mid,
  });
  return mid;
}

/**
 * Delete the sibling row when one side is deleted.
 * `source` = 'study' | 'dataroom' — the side being deleted (skipped in the sibling delete).
 * Returns { removedStudy, removedDataroom }.
 */
async function deleteSibling(mirrorId, source) {
  if (!mirrorId) return { removedStudy: false, removedDataroom: false };
  let removedStudy = false, removedDataroom = false;
  if (source !== 'study') {
    const rows = await sbSelect('study_files', `select=id&mirror_id=eq.${mirrorId}&limit=1`);
    if (rows.length) {
      await sbDelete('study_files', `mirror_id=eq.${mirrorId}`);
      removedStudy = true;
    }
  }
  if (source !== 'dataroom') {
    const rows = await sbSelect('dataroom_files', `select=id&mirror_id=eq.${mirrorId}&limit=1`);
    if (rows.length) {
      await sbDelete('dataroom_files', `mirror_id=eq.${mirrorId}`);
      removedDataroom = true;
    }
  }
  return { removedStudy, removedDataroom };
}

module.exports = {
  SECTOR_BRIEFS_FOLDER_ID,
  ensureMirrorId,
  mirrorStudyToDataroom,
  mirrorDataroomToStudy,
  deleteSibling,
};
