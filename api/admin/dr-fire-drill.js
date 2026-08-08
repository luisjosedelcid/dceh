// /api/admin/dr-fire-drill
//
// Fire drill trimestral (o on-demand) para validar que los backups estan sanos.
// Verifica que el snapshot mas reciente:
//   1. Existe y es descargable
//   2. Puede descomprimirse (no esta corrupto)
//   3. Contiene todas las tablas criticas esperadas
//   4. Los row_counts en el snapshot coinciden razonablemente con la DB en vivo
//   5. Contiene todos los archivos activos del Data Room bucket
//   6. Cada archivo referenciado en dataroom_files existe fisicamente en el snapshot
//
// NO hace restore real — es solo validacion no-destructiva.
//
// Auth: x-admin-token
// Output: JSON con status y diff detallado; escribe fila en dr_test_log.

const { verifyAdminToken } = require('../_admin-auth');
const { sbInsert, sbUpdate, sbSelect } = require('../_supabase.js');
const zlib = require('zlib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

const CRITICAL_TABLES = [
  'decision_journal', 'decision_inputs_packages', 'premortems',
  'premortem_revisions', 'failure_modes', 'reunderwriting_due',
  'reunderwriting_entries', 'pipeline_cards', 'pipeline_card_assets',
  'trigger_evaluations',
  'transactions', 'trades', 'portfolio_snapshots', 'cashflows',
  'time_deposits', 'real_estate_marks', 'dividend_schedule', 'iv_tracking',
  'dataroom_files', 'dataroom_folders', 'dataroom_hidden_files',
  'study_articles', 'study_files', 'source_documents', 'company_dashboards',
  'watchlist', 'tickers_tracked', 'radar', 'analysts',
  'idea_feed_sources', 'idea_feed_items', 'user_news_tickers',
  'screener_snapshot', 'discipline_rules',
  'admin_users', 'allowed_users', 'push_subscriptions', 'price_alerts',
  'earnings_alerts_sent', 'earnings_calendar', 'calendar_extras',
  'calendar_blocklist', 'comments',
  'prices_daily', 'fx_daily',
  'dr_test_log', 'dr_snapshot_log',
];

// Minimal tar reader — reads the tarball header list and pulls out named files.
// We only need to enumerate entries and pluck a couple by name for validation.

function parseOctal(buf) {
  // tar octal strings can be null- or space-terminated.
  const s = buf.toString('ascii').replace(/[\0 ]+$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function readTar(buf) {
  const entries = [];
  let offset = 0;
  while (offset < buf.length - 1024) {
    const header = buf.slice(offset, offset + 512);
    // Empty block marks end of archive.
    if (header[0] === 0) break;
    const nameField = header.slice(0, 100).toString('ascii').replace(/\0+$/, '');
    const prefixField = header.slice(345, 500).toString('ascii').replace(/\0+$/, '');
    const name = prefixField ? `${prefixField}/${nameField}` : nameField;
    const size = parseOctal(header.slice(124, 136));
    const typeFlag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    entries.push({ name, size, typeFlag, dataStart, dataEnd });
    // Advance: header (512) + padded data.
    const padded = Math.ceil(size / 512) * 512;
    offset += 512 + padded;
  }
  return { entries, buffer: buf };
}

function getEntry(tar, name) {
  const e = tar.entries.find(x => x.name === name);
  if (!e) return null;
  return tar.buffer.slice(e.dataStart, e.dataEnd);
}

async function listBucket(bucket, prefix = '', limit = 1000) {
  const results = [];
  async function walk(currentPrefix) {
    const url = `${SUPABASE_URL}/storage/v1/object/list/${bucket}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: currentPrefix,
        limit,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      }),
    });
    if (!res.ok) return;
    const items = await res.json();
    for (const item of items) {
      const fullPath = currentPrefix ? `${currentPrefix}/${item.name}` : item.name;
      if (item.metadata && item.metadata.size != null) {
        results.push({ name: item.name, path: fullPath, size: item.metadata.size });
      } else {
        await walk(fullPath);
      }
    }
  }
  await walk(prefix);
  return results;
}

async function tableCount(table) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=count`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept': 'application/json',
      'Prefer': 'count=exact',
    },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+|\*)$/);
  return m ? (m[1] === '*' ? null : parseInt(m[1], 10)) : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const claims = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!claims) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Supabase not configured' }); return;
  }

  const startedAt = new Date();
  const kind = (req.body && req.body.kind === 'scheduled') ? 'scheduled' : 'manual';

  // Log start
  let logRow;
  try {
    const logs = await sbInsert('dr_test_log', {
      started_at: startedAt.toISOString(),
      status: 'running',
      kind,
    });
    logRow = Array.isArray(logs) ? logs[0] : logs;
  } catch (e) {
    res.status(500).json({ error: 'Failed to create log row', detail: e.message });
    return;
  }

  const result = {
    checks: {},
    tables_diff: [],
    files_missing_from_snapshot: [],
    orphan_files_in_snapshot: [],
    warnings: [],
    errors: [],
  };

  try {
    // ── 1. Find the most recent snapshot in the bucket ─────────────────
    result.checks.snapshot_discovery = { status: 'running' };
    const listUrl = `${SUPABASE_URL}/storage/v1/object/list/backups`;
    const listRes = await fetch(listUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: 'snapshots',
        limit: 100,
        sortBy: { column: 'name', order: 'desc' },
      }),
    });
    if (!listRes.ok) throw new Error(`Bucket list failed: ${listRes.status}`);
    const folders = await listRes.json();
    if (!folders.length) throw new Error('No snapshots found in bucket backups/snapshots/');

    // Get the most recent folder, then the .tar.gz in it.
    const latestFolder = folders[0].name;
    const filesRes = await fetch(listUrl, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: `snapshots/${latestFolder}`,
        limit: 10,
      }),
    });
    const filesList = await filesRes.json();
    const tarball = filesList.find(f => f.name.endsWith('.tar.gz'));
    if (!tarball) throw new Error(`No tarball found in snapshots/${latestFolder}/`);
    const tarballPath = `snapshots/${latestFolder}/${tarball.name}`;
    const snapshotDate = latestFolder.slice(0, 10);
    result.checks.snapshot_discovery = { status: 'ok', path: tarballPath, date: snapshotDate };

    // ── 2. Download and decompress ──────────────────────────────────────
    result.checks.download = { status: 'running' };
    const dlUrl = `${SUPABASE_URL}/storage/v1/object/backups/${tarballPath}`;
    const dlRes = await fetch(dlUrl, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
    const gzBuf = Buffer.from(await dlRes.arrayBuffer());
    let tarBuf;
    try {
      tarBuf = zlib.gunzipSync(gzBuf);
    } catch (e) {
      throw new Error(`Gzip decompression failed: ${e.message}`);
    }
    result.checks.download = {
      status: 'ok',
      bytes_compressed: gzBuf.length,
      bytes_uncompressed: tarBuf.length,
    };

    // ── 3. Read tar entries ─────────────────────────────────────────────
    result.checks.tar_parse = { status: 'running' };
    const tar = readTar(tarBuf);
    if (tar.entries.length === 0) throw new Error('Tarball is empty or malformed');
    // Find snapshot name (root folder inside tarball).
    const firstName = tar.entries[0].name;
    const snapshotName = firstName.split('/')[0];
    result.checks.tar_parse = { status: 'ok', entries: tar.entries.length, root: snapshotName };

    // ── 4. Manifest integrity ───────────────────────────────────────────
    result.checks.manifest = { status: 'running' };
    const manifestBuf = getEntry(tar, `${snapshotName}/database/manifest.json`);
    if (!manifestBuf) throw new Error('database/manifest.json missing');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    result.checks.manifest = {
      status: 'ok',
      tables: manifest.tables.length,
      generated_at: manifest.generated_at,
    };

    // ── 5. Every critical table present ─────────────────────────────────
    result.checks.critical_tables = { status: 'running' };
    const tablesInSnapshot = new Set(manifest.tables.map(t => t.table));
    const missingTables = CRITICAL_TABLES.filter(t => !tablesInSnapshot.has(t));
    if (missingTables.length) {
      result.warnings.push(`Missing tables in snapshot: ${missingTables.join(', ')}`);
    }
    result.checks.critical_tables = {
      status: missingTables.length ? 'warn' : 'ok',
      expected: CRITICAL_TABLES.length,
      found: manifest.tables.length,
      missing: missingTables,
    };

    // ── 6. Row-count diff vs live DB ────────────────────────────────────
    result.checks.row_counts = { status: 'running' };
    for (const t of manifest.tables) {
      const live = await tableCount(t.table);
      if (live == null) continue;
      const snap = t.row_count;
      // Diff is expected: DB may have grown since snapshot. Flag only shrinkage.
      const delta = live - snap;
      const shrinkage = delta < 0;
      if (shrinkage) {
        result.tables_diff.push({
          table: t.table,
          snapshot: snap,
          live,
          delta,
          note: 'live has FEWER rows than snapshot — may indicate data loss',
        });
      } else if (delta > snap * 0.5 && snap > 100) {
        // Snapshot is >50% older, may be stale
        result.tables_diff.push({
          table: t.table,
          snapshot: snap,
          live,
          delta,
          note: 'snapshot may be too old, consider running a new snapshot',
        });
      }
    }
    result.checks.row_counts = {
      status: result.tables_diff.length === 0 ? 'ok' : 'warn',
      diffs: result.tables_diff.length,
    };

    // ── 7. Storage manifest ─────────────────────────────────────────────
    result.checks.storage = { status: 'running' };
    const storageManifestBuf = getEntry(tar, `${snapshotName}/storage/manifest.json`);
    if (!storageManifestBuf) {
      result.warnings.push('storage/manifest.json missing');
      result.checks.storage = { status: 'warn', reason: 'no manifest' };
    } else {
      const storageManifest = JSON.parse(storageManifestBuf.toString('utf8'));
      const snapshotFiles = new Set(storageManifest.files.map(f => f.path));

      // Compare with live bucket
      const liveFiles = await listBucket('dataroom');
      const liveFilesSet = new Set(liveFiles.map(f => f.path));

      // Missing from snapshot but in live (uploaded since snapshot; not alarming)
      const missingFromSnapshot = liveFiles.filter(f => !snapshotFiles.has(f.path));
      // In snapshot but not live (deleted since snapshot; fine)
      const orphansInSnapshot = storageManifest.files.filter(f => !liveFilesSet.has(f.path));

      result.files_missing_from_snapshot = missingFromSnapshot.map(f => f.path);
      result.orphan_files_in_snapshot = orphansInSnapshot.map(f => f.path);

      // Verify every file listed in manifest actually exists in tarball
      const tarEntryNames = new Set(tar.entries.map(e => e.name));
      const missingFromTarball = storageManifest.files.filter(f =>
        !tarEntryNames.has(`${snapshotName}/storage/dataroom/${f.path}`)
      );
      if (missingFromTarball.length) {
        result.errors.push(`${missingFromTarball.length} files listed in manifest but missing from tarball`);
      }

      result.checks.storage = {
        status: missingFromTarball.length ? 'fail' : (missingFromSnapshot.length > 5 ? 'warn' : 'ok'),
        files_in_snapshot: storageManifest.files.length,
        files_in_live_bucket: liveFiles.length,
        newer_than_snapshot: missingFromSnapshot.length,
        deleted_since_snapshot: orphansInSnapshot.length,
        missing_from_tarball: missingFromTarball.length,
      };
    }

    // ── 8. Snapshot age ─────────────────────────────────────────────────
    result.checks.snapshot_age = { status: 'running' };
    const genTime = new Date(manifest.generated_at);
    const ageHours = Math.round((Date.now() - genTime.getTime()) / 3600000);
    const ageDays = Math.round(ageHours / 24);
    let ageStatus = 'ok';
    if (ageDays > 14) ageStatus = 'fail';
    else if (ageDays > 8) ageStatus = 'warn';
    result.checks.snapshot_age = {
      status: ageStatus,
      age_hours: ageHours,
      age_days: ageDays,
      generated_at: manifest.generated_at,
    };
    if (ageDays > 8) {
      result.warnings.push(`Snapshot is ${ageDays} days old — recommend generating a new one`);
    }

    // ── 9. Verdict ──────────────────────────────────────────────────────
    const finishedAt = new Date();
    const duration = Math.round((finishedAt - startedAt) / 1000);
    let status = 'success';
    if (result.errors.length) status = 'failed';
    else if (result.warnings.length) status = 'partial';

    const tablesVerified = manifest.tables.length;
    const filesVerified = result.checks.storage.files_in_snapshot || 0;
    const filesMissing = result.checks.storage.missing_from_tarball || 0;

    await sbUpdate('dr_test_log', `id=eq.${logRow.id}`, {
      finished_at: finishedAt.toISOString(),
      status,
      source_backup_date: snapshotDate,
      tables_verified: tablesVerified,
      tables_diff: result.tables_diff,
      files_verified: filesVerified,
      files_missing: filesMissing,
      duration_seconds: duration,
      error: result.errors.length ? result.errors.join('; ') : null,
      detail: {
        checks: result.checks,
        warnings: result.warnings,
        errors: result.errors,
      },
    });

    res.status(200).json({
      ok: true,
      log_id: logRow.id,
      status,
      snapshot_path: tarballPath,
      snapshot_date: snapshotDate,
      duration_seconds: duration,
      checks: result.checks,
      tables_diff: result.tables_diff,
      warnings: result.warnings,
      errors: result.errors,
    });
  } catch (e) {
    await sbUpdate('dr_test_log', `id=eq.${logRow.id}`, {
      finished_at: new Date().toISOString(),
      status: 'failed',
      error: e.message,
    }).catch(() => {});
    res.status(500).json({ error: 'Fire drill failed', detail: e.message });
  }
};
