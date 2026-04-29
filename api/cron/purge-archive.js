// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Auto-purge Archive cron
// GET /api/cron/purge-archive
//
// Walks each archive/<folder>/ in Supabase Storage (monthly, committee,
// annual), groups versioned files by base filename (filenames are stored
// as `<unix_ts>__<filename>`), and deletes archive entries that meet
// BOTH conditions:
//   - older than ARCHIVE_RETENTION_DAYS (default 90)
//   - the group still has more than ARCHIVE_MIN_VERSIONS (default 5)
//     newer versions kept after the deletion
//
// In other words: we always keep the N newest versions of any file, no
// matter how old they are. We only prune the long tail.
//
// Each delete writes a `purge` row to report_audit.
//
// Triggered by Vercel cron (see vercel.json).
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbInsert } = require('../_supabase.js');

const FOLDERS = ['monthly', 'committee', 'annual'];

async function listArchive(folder, supabaseUrl, serviceKey) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/list/reports`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix: `archive/${folder}/`,
      limit: 1000,
      sortBy: { column: 'name', order: 'desc' },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`list archive/${folder} failed: ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function deleteObject(path, supabaseUrl, serviceKey) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/reports/${path}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`delete ${path} failed: ${r.status} ${txt.slice(0, 200)}`);
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '90', 10);
  const MIN_VERSIONS = parseInt(process.env.ARCHIVE_MIN_VERSIONS || '5', 10);
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Optional dry-run: ?dry=1
  const dryRun = req.query && (req.query.dry === '1' || req.query.dry === 'true');

  const summary = {
    ok: true,
    retention_days: RETENTION_DAYS,
    min_versions: MIN_VERSIONS,
    dry_run: !!dryRun,
    folders: {},
    total_scanned: 0,
    total_deleted: 0,
    total_errors: 0,
  };

  for (const folder of FOLDERS) {
    const folderResult = { scanned: 0, groups: 0, deleted: 0, kept: 0, errors: 0, deletions: [] };

    let items;
    try {
      items = await listArchive(folder, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    } catch (e) {
      folderResult.errors += 1;
      folderResult.error_detail = String(e).slice(0, 200);
      summary.folders[folder] = folderResult;
      summary.total_errors += 1;
      continue;
    }

    folderResult.scanned = items.length;
    summary.total_scanned += items.length;

    // Parse and group by base filename: name = "<unix_ts>__<filename>"
    const groups = new Map();
    for (const it of items) {
      if (!it || !it.name) continue;
      const m = it.name.match(/^(\d+)__(.+)$/);
      if (!m) continue;
      const tsMs = parseInt(m[1], 10) * 1000;
      const baseFilename = m[2];
      if (!Number.isFinite(tsMs)) continue;
      if (!groups.has(baseFilename)) groups.set(baseFilename, []);
      groups.get(baseFilename).push({
        archiveName: it.name,
        archivePath: `archive/${folder}/${it.name}`,
        baseFilename,
        tsMs,
        sizeBytes: it.metadata && it.metadata.size,
      });
    }

    folderResult.groups = groups.size;

    for (const [baseFilename, versions] of groups) {
      // Newest first
      versions.sort((a, b) => b.tsMs - a.tsMs);

      // Always keep the newest MIN_VERSIONS
      const keep = versions.slice(0, MIN_VERSIONS);
      const candidates = versions.slice(MIN_VERSIONS);
      folderResult.kept += keep.length;

      for (const v of candidates) {
        if (v.tsMs >= cutoffMs) {
          // newer than retention window — keep it
          folderResult.kept += 1;
          continue;
        }

        if (dryRun) {
          folderResult.deleted += 1;
          folderResult.deletions.push({ path: v.archivePath, ts: v.tsMs, size: v.sizeBytes, dry: true });
          continue;
        }

        try {
          await deleteObject(v.archivePath, SUPABASE_URL, SUPABASE_SERVICE_KEY);
          folderResult.deleted += 1;
          summary.total_deleted += 1;
          folderResult.deletions.push({ path: v.archivePath, ts: v.tsMs, size: v.sizeBytes });

          // Audit (best-effort, non-blocking)
          sbInsert('report_audit', {
            actor_email: 'cron@dceholdings.app',
            action: 'purge',
            folder,
            filename: baseFilename,
            size_bytes: v.sizeBytes || null,
            detail: v.archivePath,
          }).catch(() => {});
        } catch (e) {
          folderResult.errors += 1;
          summary.total_errors += 1;
          folderResult.deletions.push({ path: v.archivePath, error: String(e).slice(0, 160) });
        }
      }
    }

    summary.folders[folder] = folderResult;
  }

  res.status(200).json(summary);
};
