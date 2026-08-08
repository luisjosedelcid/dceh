// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Nightly Backup cron
// GET /api/cron/backup-nightly
//
// Runs every night at 03:00 UTC. Dumps critical Postgres tables as
// JSON to the `backups` Supabase Storage bucket and mirrors the
// `dataroom` bucket contents.
//
// Storage layout:
//   backups/nightly/<YYYY-MM-DD>/tables/<table>.json
//   backups/nightly/<YYYY-MM-DD>/dataroom/<original storage_path>
//   backups/nightly/<YYYY-MM-DD>/manifest.json
//
// Retention (enforced at end of run):
//   - Daily snapshots for last 30 days (nightly/)
//   - Monthly snapshots (first-of-month) for last 12 months (monthly/)
//   - Older nightly snapshots are deleted; first-of-month is promoted
//     to monthly/ and kept 12 months.
//
// Every run writes a row to public.backup_log.
//
// Triggered by Vercel cron (see vercel.json).
// Auth: bearer CRON_SECRET or x-vercel-cron-schedule header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbInsert, sbUpdate } = require('../_supabase.js');

// Tables backed up every night. Order matters only for readability.
const CRITICAL_TABLES = [
  // Investment decisions & research
  'decision_journal',
  'decision_inputs_packages',
  'premortems',
  'premortem_revisions',
  'failure_modes',
  'reunderwriting_due',
  'reunderwriting_entries',
  'pipeline_cards',
  'pipeline_card_assets',
  'trigger_evaluations',
  // Portfolio & trades
  'transactions',
  'trades',
  'portfolio_snapshots',
  'cashflows',
  'time_deposits',
  'real_estate_marks',
  'dividend_schedule',
  'iv_tracking',
  // Data Room & research artifacts
  'dataroom_files',
  'dataroom_folders',
  'dataroom_hidden_files',
  'study_articles',
  'study_files',
  'source_documents',
  'company_dashboards',
  // Watchlist & universe
  'watchlist',
  'tickers_tracked',
  'radar',
  'analysts',
  // Idea Feed
  'idea_feed_sources',
  'idea_feed_items',
  'user_news_tickers',
  // Screener
  'screener_snapshot',
  'discipline_rules',
  // Users & admin
  'admin_users',
  'allowed_users',
  'push_subscriptions',
  'price_alerts',
  'earnings_alerts_sent',
  'earnings_calendar',
  'calendar_extras',
  'calendar_blocklist',
  'comments',
  // Prices (large but critical for auditability)
  'prices_daily',
  'fx_daily',
];

// ── Helpers ────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }
function pad(n) { return String(n).padStart(2, '0'); }
function dateFolder(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}
function monthFolder(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}`;
}

// Fetch all rows from a table using pagination (Supabase PostgREST caps at 1000).
async function fetchTable(table, supabaseUrl, serviceKey) {
  const pageSize = 1000;
  let offset = 0;
  const rows = [];
  while (true) {
    const url = `${supabaseUrl}/rest/v1/${table}?select=*&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Prefer': 'count=exact',
      },
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${table} fetch failed: ${r.status} ${txt.slice(0,200)}`);
    }
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 500000) throw new Error(`${table}: refusing to fetch > 500k rows`);
  }
  return rows;
}

async function uploadJson(bucket, path, obj, supabaseUrl, serviceKey) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/json',
      'x-upsert': 'true',
    },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`upload ${path} failed: ${r.status} ${txt.slice(0,200)}`);
  }
  return body.length;
}

async function copyStorageObject(fromBucket, fromPath, toBucket, toPath, supabaseUrl, serviceKey) {
  const url = `${supabaseUrl}/storage/v1/object/copy`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: fromBucket,
      sourceKey: fromPath,
      destinationBucket: toBucket,
      destinationKey: toPath,
    }),
  });
  if (r.ok) return { ok: true };
  // Distinguish orphan (source file missing) from real errors.
  // Supabase returns 404 or 400 with body containing "not found" / "NoSuchKey"
  // when the source object does not exist.
  const txt = await r.text().catch(() => '');
  const bodyLower = txt.toLowerCase();
  const isOrphan =
    r.status === 404 ||
    bodyLower.includes('not found') ||
    bodyLower.includes('nosuchkey') ||
    bodyLower.includes('object not found');
  return { ok: false, status: r.status, body: txt.slice(0, 200), orphan: isOrphan };
}

async function listStorageFolder(bucket, prefix, supabaseUrl, serviceKey, limit = 1000) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!r.ok) return [];
  return await r.json();
}

async function deleteStorageObjects(bucket, paths, supabaseUrl, serviceKey) {
  if (!paths.length) return 0;
  const r = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  });
  return r.ok ? paths.length : 0;
}

// ── Handler ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Auth
  const expected = process.env.CRON_SECRET;
  const authHdr = req.headers.authorization || '';
  const bearerOk = !!expected && authHdr === `Bearer ${expected}`;
  const cronHdrOk = !!expected && req.headers['x-cron-secret'] === expected;
  const isVercelCron = 'x-vercel-cron-schedule' in req.headers;
  if (!bearerOk && !cronHdrOk && !isVercelCron) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const startedAt = new Date();
  const runId = `nightly-${startedAt.toISOString().replace(/[:.]/g,'-')}`;
  const kind = req.query && req.query.kind === 'manual' ? 'manual' : 'nightly';
  const skipDataroom = req.query && req.query.skip_dataroom === '1';
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');

  // Open a running row
  let logRow = null;
  try {
    const inserted = await sbInsert('backup_log', {
      run_id: runId,
      status: 'running',
      kind,
      started_at: startedAt.toISOString(),
      detail: { dry },
    });
    logRow = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (e) {
    // Best-effort; continue even if log open fails.
  }

  const dayFolder = dateFolder(startedAt);
  const basePath = `nightly/${dayFolder}`;
  const stats = {
    tables_dumped: 0,
    rows_total: 0,
    bytes_tables: 0,
    files_mirrored: 0,
    bytes_dataroom: 0,
    errors: [],
    orphans: [],
  };

  // ── Dump tables ──────────────────────────────────────────────
  for (const table of CRITICAL_TABLES) {
    try {
      const rows = await fetchTable(table, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      if (!dry) {
        const bytes = await uploadJson(
          'backups',
          `${basePath}/tables/${table}.json`,
          { table, dumped_at: nowIso(), row_count: rows.length, rows },
          SUPABASE_URL,
          SUPABASE_SERVICE_KEY
        );
        stats.bytes_tables += bytes;
      }
      stats.tables_dumped += 1;
      stats.rows_total += rows.length;
    } catch (e) {
      stats.errors.push({ scope: 'table', table, error: String(e).slice(0, 200) });
    }
  }

  // ── Mirror dataroom bucket ───────────────────────────────────
  if (!skipDataroom) {
    try {
      const dataroomFiles = await sbSelect(
        'dataroom_files',
        `select=id,filename,storage_path,size_bytes&limit=10000`
      );
      for (const f of dataroomFiles) {
        if (!f.storage_path) continue;
        try {
          if (!dry) {
            const res = await copyStorageObject(
              'dataroom', f.storage_path,
              'backups', `${basePath}/dataroom/${f.storage_path}`,
              SUPABASE_URL, SUPABASE_SERVICE_KEY
            );
            if (!res.ok) {
              if (res.orphan) {
                // Source object missing in storage but row still in dataroom_files.
                // Track as orphan (data-integrity issue) — not a backup failure.
                stats.orphans.push({
                  path: f.storage_path,
                  file_id: f.id || null,
                  filename: f.filename || null,
                });
                continue;
              }
              throw new Error(`copy failed: ${res.status} ${res.body || ''}`.trim());
            }
          }
          stats.files_mirrored += 1;
          stats.bytes_dataroom += Number(f.size_bytes || 0);
        } catch (e) {
          stats.errors.push({ scope: 'dataroom', path: f.storage_path, error: String(e).slice(0, 200) });
        }
      }
    } catch (e) {
      stats.errors.push({ scope: 'dataroom-list', error: String(e).slice(0, 200) });
    }
  }

  // ── Upload manifest ──────────────────────────────────────────
  const manifest = {
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: nowIso(),
    kind,
    tables: CRITICAL_TABLES,
    stats,
  };
  if (!dry) {
    try {
      await uploadJson('backups', `${basePath}/manifest.json`, manifest, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    } catch (e) {
      stats.errors.push({ scope: 'manifest', error: String(e).slice(0, 200) });
    }
  }

  // ── Promote first-of-month to monthly/ (idempotent copy) ─────
  const isFirstOfMonth = startedAt.getUTCDate() === 1;
  if (isFirstOfMonth && !dry) {
    try {
      const mFolder = monthFolder(startedAt);
      // We copy the manifest as the presence marker; a full copy of every
      // object would double storage. Instead we tag the day folder as
      // preserved by writing a monthly/<YYYY-MM>/ref.json that points to
      // the nightly/<YYYY-MM-DD>/ folder.
      await uploadJson(
        'backups',
        `monthly/${mFolder}/ref.json`,
        { source: basePath, promoted_at: nowIso(), run_id: runId },
        SUPABASE_URL,
        SUPABASE_SERVICE_KEY
      );
    } catch (e) {
      stats.errors.push({ scope: 'monthly-promote', error: String(e).slice(0, 200) });
    }
  }

  // ── Retention: prune nightly/ older than 30 days unless referenced by monthly/ ─
  const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAILY_DAYS || '30', 10);
  const monthlyKeepMonths = parseInt(process.env.BACKUP_RETENTION_MONTHLY_MONTHS || '12', 10);
  let purgedDaily = 0;
  let purgedMonthly = 0;
  if (!dry) {
    try {
      // Read all monthly/ refs to know which nightly folders to preserve.
      const monthlyRefs = await listStorageFolder('backups', 'monthly/', SUPABASE_URL, SUPABASE_SERVICE_KEY, 200);
      const preservedNightlyPaths = new Set();
      for (const entry of (monthlyRefs || [])) {
        // Each entry is a monthly/<YYYY-MM>/ folder; fetch its ref.json.
        const refPath = `monthly/${entry.name}/ref.json`;
        try {
          const r = await fetch(`${SUPABASE_URL}/storage/v1/object/backups/${refPath}`, {
            headers: {
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'apikey': SUPABASE_SERVICE_KEY,
            },
          });
          if (r.ok) {
            const j = await r.json();
            if (j && j.source) preservedNightlyPaths.add(j.source);
          }
        } catch {}
      }

      // Prune nightly/ folders older than retention window
      const nightlyFolders = await listStorageFolder('backups', 'nightly/', SUPABASE_URL, SUPABASE_SERVICE_KEY, 200);
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const toDelete = [];
      for (const entry of (nightlyFolders || [])) {
        // entry.name is <YYYY-MM-DD>
        const parts = (entry.name || '').split('-');
        if (parts.length !== 3) continue;
        const t = Date.parse(`${entry.name}T00:00:00Z`);
        if (Number.isNaN(t)) continue;
        if (t > cutoff) continue;
        const fullPath = `nightly/${entry.name}`;
        if (preservedNightlyPaths.has(fullPath)) continue;
        toDelete.push(fullPath);
      }
      // List every object inside each expired folder and delete individually.
      for (const folder of toDelete) {
        try {
          const objs = await listStorageFolder('backups', `${folder}/`, SUPABASE_URL, SUPABASE_SERVICE_KEY, 1000);
          // Recursively enumerate subfolders (tables/, dataroom/)
          const allPaths = [];
          for (const sub of (objs || [])) {
            const subPath = `${folder}/${sub.name}`;
            if (sub.metadata && sub.metadata.size >= 0) {
              allPaths.push(subPath);
            } else {
              // Directory — list contents recursively (max 2 deep)
              const deep = await listStorageFolder('backups', `${subPath}/`, SUPABASE_URL, SUPABASE_SERVICE_KEY, 5000);
              for (const d of (deep || [])) {
                const dPath = `${subPath}/${d.name}`;
                if (d.metadata && d.metadata.size >= 0) {
                  allPaths.push(dPath);
                } else {
                  const deeper = await listStorageFolder('backups', `${dPath}/`, SUPABASE_URL, SUPABASE_SERVICE_KEY, 5000);
                  for (const dd of (deeper || [])) {
                    allPaths.push(`${dPath}/${dd.name}`);
                  }
                }
              }
            }
          }
          if (allPaths.length) {
            const del = await fetch(`${SUPABASE_URL}/storage/v1/object/backups`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ prefixes: allPaths }),
            });
            if (del.ok) purgedDaily += allPaths.length;
          }
        } catch (e) {
          stats.errors.push({ scope: 'retention-nightly', folder, error: String(e).slice(0, 200) });
        }
      }

      // Prune monthly/ older than monthlyKeepMonths
      const monthCutoff = new Date();
      monthCutoff.setUTCMonth(monthCutoff.getUTCMonth() - monthlyKeepMonths);
      for (const entry of (monthlyRefs || [])) {
        const name = entry.name || '';
        const parts = name.split('-');
        if (parts.length !== 2) continue;
        const yr = parseInt(parts[0], 10);
        const mo = parseInt(parts[1], 10);
        if (!yr || !mo) continue;
        const entryDate = new Date(Date.UTC(yr, mo - 1, 1));
        if (entryDate >= monthCutoff) continue;
        // Delete the whole monthly/<YYYY-MM>/ folder (usually just ref.json)
        try {
          const objs = await listStorageFolder('backups', `monthly/${name}/`, SUPABASE_URL, SUPABASE_SERVICE_KEY, 100);
          const paths = (objs || []).map(o => `monthly/${name}/${o.name}`);
          if (paths.length) {
            const del = await fetch(`${SUPABASE_URL}/storage/v1/object/backups`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ prefixes: paths }),
            });
            if (del.ok) purgedMonthly += paths.length;
          }
        } catch (e) {
          stats.errors.push({ scope: 'retention-monthly', folder: name, error: String(e).slice(0, 200) });
        }
      }
    } catch (e) {
      stats.errors.push({ scope: 'retention', error: String(e).slice(0, 200) });
    }
  }

  stats.purged_daily = purgedDaily;
  stats.purged_monthly = purgedMonthly;

  // ── Close log row ────────────────────────────────────────────
  // Orphans (source file missing in bucket) are a data-integrity issue,
  // NOT a backup failure. They're tracked in stats.orphans and surfaced
  // in the error field for visibility, but do not degrade status.
  const status = stats.errors.length === 0
    ? 'success'
    : (stats.tables_dumped > 0 ? 'partial' : 'failed');

  const errorSummary = (() => {
    const parts = [];
    if (stats.errors.length) parts.push(`${stats.errors.length} errors`);
    if (stats.orphans.length) parts.push(`${stats.orphans.length} orphans`);
    return parts.length ? parts.join(' + ') : null;
  })();

  if (logRow && logRow.id) {
    try {
      await sbUpdate('backup_log', `id=eq.${logRow.id}`, {
        finished_at: nowIso(),
        status,
        tables_dumped: stats.tables_dumped,
        rows_total: stats.rows_total,
        files_mirrored: stats.files_mirrored,
        bytes_total: stats.bytes_tables + stats.bytes_dataroom,
        storage_path: basePath,
        error: errorSummary,
        detail: { stats, dry },
      });
    } catch {}
  }

  res.status(200).json({
    ok: status !== 'failed',
    run_id: runId,
    status,
    stats,
    storage_path: basePath,
    dry,
  });
};
