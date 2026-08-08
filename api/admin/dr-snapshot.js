// /api/admin/dr-snapshot
// Generate a full Disaster Recovery snapshot on-demand.
//
// The snapshot is a self-contained package that lets you rebuild the entire
// site from scratch on any new Supabase + Vercel account:
//   - database/tables/*.json  → 45+ tables (rows + metadata)
//   - database/manifest.json  → what was dumped, row counts, timestamps
//   - storage/dataroom/...    → every PDF/file in the Data Room bucket
//   - config/site-metadata.json → Supabase project id, region, plan, domain
//   - config/RESTORE-README.md → next steps for the operator
//
// Env vars are NOT included (security). The operator restores them manually
// from a GPG-encrypted file they maintain separately.
//
// Auth: admin bearer token in x-admin-token header.
// Output: uploads a .tar.gz to bucket `backups/snapshots/YYYY-MM-DD_HHMM/` and
//   returns a signed URL (15 min TTL) for download.

const { verifyAdminToken } = require('../_admin-auth');
const { sbInsert, sbUpdate } = require('../_supabase.js');
const zlib = require('zlib');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

// Same list as backup-nightly.js. If you add tables there, add them here too.
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

// ── Utilities ─────────────────────────────────────────────────────────

function timestampFolder() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${HH}${MM}`;
}

async function fetchTable(table) {
  // Uses REST with a very high limit; if a table exceeds 50k rows we should
  // paginate — for DCE state that ceiling is safe (prices_daily is largest at ~3k).
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=50000`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`fetchTable ${table} failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function listBucket(bucket, prefix = '', limit = 1000) {
  // Recursive listing via storage API. Returns array of {name, path, size}.
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
        results.push({
          name: item.name,
          path: fullPath,
          size: item.metadata.size,
          mimetype: item.metadata.mimetype || 'application/octet-stream',
        });
      } else {
        // folder — recurse
        await walk(fullPath);
      }
    }
  }
  await walk(prefix);
  return results;
}

async function downloadObject(bucket, objectPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function uploadObject(bucket, objectPath, body, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`uploadObject ${objectPath} failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return true;
}

async function createSignedUrl(bucket, objectPath, ttlSeconds = 900) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: ttlSeconds }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`createSignedUrl failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// ── Minimal tar writer (POSIX ustar format) ──────────────────────────
// A snapshot needs to be one downloadable file. We build a tarball in memory
// then gzip it. Node has no built-in tar, so this hand-rolls the format.
// Reference: https://en.wikipedia.org/wiki/Tar_(computing)#File_format

function tarPad(buf, blockSize = 512) {
  const rem = buf.length % blockSize;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(blockSize - rem)]);
}

function tarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  // ustar header is 512 bytes.
  const header = Buffer.alloc(512);
  const writeField = (str, offset, len) => {
    const s = String(str);
    header.write(s.slice(0, len), offset, 'ascii');
  };
  const writeOctal = (val, offset, len) => {
    const s = val.toString(8).padStart(len - 1, '0') + '\0';
    header.write(s, offset, 'ascii');
  };

  // File name: max 100 chars in name field. Longer names go in prefix (155 chars).
  let filename = name;
  let prefix = '';
  if (name.length > 100) {
    // Split at last '/' before position 100.
    const splitAt = name.lastIndexOf('/', 100);
    if (splitAt > 0 && (name.length - splitAt - 1) <= 100 && splitAt <= 155) {
      prefix = name.slice(0, splitAt);
      filename = name.slice(splitAt + 1);
    } else {
      // Fallback: truncate. Should not happen with dataroom paths.
      filename = name.slice(-100);
    }
  }
  writeField(filename, 0, 100);      // name
  writeOctal(0o644, 100, 8);         // mode
  writeOctal(0, 108, 8);             // uid
  writeOctal(0, 116, 8);             // gid
  writeOctal(size, 124, 12);         // size
  writeOctal(mtime, 136, 12);        // mtime
  writeField('        ', 148, 8);    // checksum placeholder (spaces)
  writeField('0', 156, 1);           // typeflag (regular file)
  writeField('', 157, 100);          // linkname
  writeField('ustar\0', 257, 6);     // magic
  writeField('00', 263, 2);          // version
  writeField('', 265, 32);           // uname
  writeField('', 297, 32);           // gname
  writeOctal(0, 329, 8);             // devmajor
  writeOctal(0, 337, 8);             // devminor
  writeField(prefix, 345, 155);      // prefix

  // Compute checksum: sum of all bytes with checksum field as spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  writeOctal(sum, 148, 7);
  header.write('\0 ', 154, 'ascii'); // checksum trailer: null + space
  header[155] = 0x20;

  return header;
}

function tarEntry(name, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = tarHeader(name, buf.length);
  const padded = tarPad(buf);
  return Buffer.concat([header, padded]);
}

function tarClose() {
  // Two empty 512-byte blocks mark end of archive.
  return Buffer.alloc(1024);
}

// ── Main handler ──────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authTok = req.headers['x-admin-token'];
  const claims = verifyAdminToken(authTok, ADMIN_TOKEN_SECRET);
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Supabase not configured' });
    return;
  }

  const startedAt = new Date();
  const stamp = timestampFolder();
  const snapshotName = `dr-snapshot-${stamp}`;
  const snapshotPath = `snapshots/${stamp}/${snapshotName}.tar.gz`;

  // Insert log row
  let logRow;
  try {
    const logs = await sbInsert('dr_snapshot_log', {
      started_at: startedAt.toISOString(),
      status: 'running',
      kind: req.body && req.body.kind === 'scheduled' ? 'scheduled' : 'manual',
      destination: 'supabase-bucket:backups',
      snapshot_path: snapshotPath,
    });
    logRow = Array.isArray(logs) ? logs[0] : logs;
  } catch (e) {
    res.status(500).json({ error: 'Failed to create log row', detail: e.message });
    return;
  }

  const tarEntries = [];
  const stats = {
    tables_included: 0,
    tables_failed: [],
    files_included: 0,
    files_failed: [],
    total_uncompressed_bytes: 0,
  };

  try {
    // ── 1. Database dumps ────────────────────────────────────────────
    const tableManifest = { generated_at: startedAt.toISOString(), tables: [] };
    for (const table of CRITICAL_TABLES) {
      try {
        const rows = await fetchTable(table);
        const json = JSON.stringify({
          table,
          dumped_at: new Date().toISOString(),
          row_count: rows.length,
          rows,
        }, null, 2);
        const entry = tarEntry(`${snapshotName}/database/tables/${table}.json`, json);
        tarEntries.push(entry);
        tableManifest.tables.push({ table, row_count: rows.length, bytes: Buffer.byteLength(json) });
        stats.tables_included++;
        stats.total_uncompressed_bytes += Buffer.byteLength(json);
      } catch (e) {
        stats.tables_failed.push({ table, error: e.message });
      }
    }
    tarEntries.push(tarEntry(
      `${snapshotName}/database/manifest.json`,
      JSON.stringify(tableManifest, null, 2)
    ));

    // ── 2. Storage files (dataroom bucket) ───────────────────────────
    const bucketList = await listBucket('dataroom');
    const fileManifest = { generated_at: new Date().toISOString(), files: [] };
    for (const f of bucketList) {
      try {
        const buf = await downloadObject('dataroom', f.path);
        if (!buf) {
          stats.files_failed.push({ path: f.path, error: 'download returned null (orphan?)' });
          continue;
        }
        const entry = tarEntry(`${snapshotName}/storage/dataroom/${f.path}`, buf);
        tarEntries.push(entry);
        fileManifest.files.push({ path: f.path, size: buf.length, mimetype: f.mimetype });
        stats.files_included++;
        stats.total_uncompressed_bytes += buf.length;
      } catch (e) {
        stats.files_failed.push({ path: f.path, error: e.message });
      }
    }
    tarEntries.push(tarEntry(
      `${snapshotName}/storage/manifest.json`,
      JSON.stringify(fileManifest, null, 2)
    ));

    // ── 3. Site metadata ─────────────────────────────────────────────
    const siteMeta = {
      generated_at: new Date().toISOString(),
      supabase_project_id: 'mlmmcciknvydlekztqtj',
      supabase_region: 'eu-west-1',
      supabase_plan: 'pro',
      vercel_project: 'dceh',
      vercel_org: 'luisjosedelcid',
      github_repo: 'luisjosedelcid/dceh',
      github_backups_repo: 'luisjosedelcid/dceh-backups',
      domain: 'dceholdings.app',
      domain_registrar: 'GoDaddy',
      admin_email: 'luis@dceholdings.com',
      canonical_url: 'https://www.dceholdings.app',
      stats,
    };
    tarEntries.push(tarEntry(
      `${snapshotName}/config/site-metadata.json`,
      JSON.stringify(siteMeta, null, 2)
    ));

    // ── 4. Restore README (inside the tarball) ───────────────────────
    const readme = `# DCE Holdings — Snapshot de Recuperacion
Generado: ${startedAt.toISOString()}
Snapshot: ${snapshotName}

Este archivo tar.gz contiene todo lo necesario para reconstruir
dceholdings.app desde cero si Supabase, Vercel o ambos desaparecen.

## Contenido

- database/tables/*.json   ← ${stats.tables_included} tablas Postgres (JSON, con filas)
- database/manifest.json   ← metadata (row counts, timestamps)
- storage/dataroom/...     ← ${stats.files_included} archivos del Data Room
- storage/manifest.json    ← inventario de archivos
- config/site-metadata.json ← IDs de proyecto, dominio, registrar

## Como usar

1. Descomprimir en tu Mac:
   tar -xzf ${snapshotName}.tar.gz

2. Seguir el runbook RESTORE.md en el repo dceh (raiz).

3. Los env vars (secrets) NO estan aqui por seguridad. Los tienes en un
   archivo GPG cifrado aparte (secrets-encrypted.gpg).

## Verificacion rapida

    ls ${snapshotName}/database/tables/ | wc -l   # debe dar ${stats.tables_included}
    ls -R ${snapshotName}/storage/dataroom/ | grep -v ':$' | grep -v '^$' | wc -l

## Contacto

luis@dceholdings.com
`;
    tarEntries.push(tarEntry(`${snapshotName}/README.md`, readme));

    // ── 5. Close tar, gzip, upload ───────────────────────────────────
    tarEntries.push(tarClose());
    const tarBuf = Buffer.concat(tarEntries);
    const gzBuf = zlib.gzipSync(tarBuf, { level: 9 });

    await uploadObject('backups', snapshotPath, gzBuf, 'application/gzip');

    // ── 6. Sign URL for download ─────────────────────────────────────
    const signedUrl = await createSignedUrl('backups', snapshotPath, 900);

    // Finish log
    const finishedAt = new Date();
    const durationS = Math.round((finishedAt - startedAt) / 1000);
    const status = stats.tables_failed.length === 0 && stats.files_failed.length === 0
      ? 'success'
      : 'partial';

    await sbUpdate('dr_snapshot_log', `id=eq.${logRow.id}`, {
      finished_at: finishedAt.toISOString(),
      status,
      bytes_total: gzBuf.length,
      tables_included: stats.tables_included,
      files_included: stats.files_included,
      checksum: null, // sha256 hex string could be added but not needed for signed URL
      detail: {
        duration_seconds: durationS,
        uncompressed_bytes: stats.total_uncompressed_bytes,
        compression_ratio: Number((stats.total_uncompressed_bytes / gzBuf.length).toFixed(2)),
        tables_failed: stats.tables_failed,
        files_failed: stats.files_failed,
      },
    });

    res.status(200).json({
      ok: true,
      snapshot_name: snapshotName,
      snapshot_path: snapshotPath,
      bytes_total: gzBuf.length,
      tables_included: stats.tables_included,
      files_included: stats.files_included,
      duration_seconds: durationS,
      download_url: signedUrl,
      download_url_expires_in_seconds: 900,
      status,
      warnings: {
        tables_failed: stats.tables_failed,
        files_failed: stats.files_failed,
      },
    });
  } catch (e) {
    await sbUpdate('dr_snapshot_log', `id=eq.${logRow.id}`, {
      finished_at: new Date().toISOString(),
      status: 'failed',
      error: e.message,
      tables_included: stats.tables_included,
      files_included: stats.files_included,
    }).catch(() => {});
    res.status(500).json({ error: 'Snapshot generation failed', detail: e.message });
  }
};
