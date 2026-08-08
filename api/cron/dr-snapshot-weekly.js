// /api/cron/dr-snapshot-weekly
// Runs weekly on Sunday at 05:00 UTC (after the existing weekly-backup workflow at 04:00).
//
// What it does:
//   1. Calls the internal /api/admin/dr-snapshot endpoint (via same auth path but
//      bypassed with CRON_SECRET) to generate a full snapshot.
//   2. Downloads the resulting tarball from the signed URL.
//   3. Uploads it to the GitHub repo `luisjosedelcid/dceh-backups` under
//      snapshots/YYYY-WNN/dr-snapshot-<timestamp>.tar.gz using the GitHub
//      Contents API.
//   4. Purges snapshots older than 12 weeks from the repo.
//   5. Sends a notification with checksum + size.
//
// Env vars required:
//   CRON_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_TOKEN_SECRET (for signing an admin token programmatically)
//   BACKUP_REPO_TOKEN — GitHub PAT with contents:write on dceh-backups
//     (create at github.com/settings/tokens, fine-grained, single repo access)
//
// Route: /api/cron/dr-snapshot-weekly

const crypto = require('crypto');
const { signToken } = require('../_admin-auth');
const { sbInsert, sbUpdate } = require('../_supabase.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
const GH_TOKEN = process.env.BACKUP_REPO_TOKEN;
const GH_REPO = 'luisjosedelcid/dceh-backups';
const RETENTION_WEEKS = 12;

function isoWeekLabel(d = new Date()) {
  // Approximate ISO week (yyyy-Www) with UTC.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  // Auth
  const authHdr = req.headers.authorization || '';
  const bearerOk = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  const cronHdrOk = !!CRON_SECRET && req.headers['x-cron-secret'] === CRON_SECRET;
  const isVercelCron = 'x-vercel-cron-schedule' in req.headers;
  if (!bearerOk && !cronHdrOk && !isVercelCron) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured (Supabase)' });
    return;
  }
  if (!GH_TOKEN) {
    res.status(500).json({ error: 'BACKUP_REPO_TOKEN not configured' });
    return;
  }

  const startedAt = new Date();

  try {
    // 1. Generate snapshot by calling our own admin endpoint.
    //    We sign an ephemeral admin token with the system secret; the endpoint
    //    doesn't care about the email as long as sig is valid.
    const { token } = signToken('system-cron@dceholdings.app', ADMIN_TOKEN_SECRET);
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'www.dceholdings.app';
    const snapUrl = `${proto}://${host}/api/admin/dr-snapshot`;
    const snapRes = await fetch(snapUrl, {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'scheduled' }),
    });
    if (!snapRes.ok) {
      const t = await snapRes.text();
      throw new Error(`Snapshot generation failed: ${snapRes.status} ${t.slice(0, 200)}`);
    }
    const snap = await snapRes.json();

    // 2. Download from signed URL.
    const dlRes = await fetch(snap.download_url);
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
    const tarballBuf = Buffer.from(await dlRes.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(tarballBuf).digest('hex');

    // 3. Upload to GitHub via Contents API.
    //    Fine-grained PAT needs Contents:read+write for luisjosedelcid/dceh-backups.
    const week = isoWeekLabel(startedAt);
    const filename = `${snap.snapshot_name}.tar.gz`;
    const ghPath = `snapshots/${week}/${filename}`;
    const ghUrl = `https://api.github.com/repos/${GH_REPO}/contents/${ghPath}`;

    // Check if file already exists (for sha in update)
    let existingSha = null;
    const check = await fetch(ghUrl, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (check.ok) {
      const data = await check.json();
      existingSha = data.sha;
    }

    const putBody = {
      message: `snapshot: ${snap.snapshot_name} (${(tarballBuf.length / 1024).toFixed(1)} KB, sha256 ${sha256.slice(0, 12)})`,
      content: tarballBuf.toString('base64'),
      branch: 'main',
    };
    if (existingSha) putBody.sha = existingSha;

    const putRes = await fetch(ghUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(putBody),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error(`GitHub upload failed: ${putRes.status} ${t.slice(0, 200)}`);
    }
    const putData = await putRes.json();

    // 4. Purge snapshots older than 12 weeks. List snapshots/ folder and delete
    //    weeks that are older than cutoff.
    const listRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/snapshots`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    let purgedCount = 0;
    if (listRes.ok) {
      const weeks = await listRes.json();
      // Sort by name (2026-W01 < 2026-W02 lexicographically works within a year;
      // across years we'd need real parsing — good enough given 12-week retention).
      const sorted = weeks.filter(w => w.type === 'dir').sort((a, b) => b.name.localeCompare(a.name));
      const toKeep = new Set(sorted.slice(0, RETENTION_WEEKS).map(w => w.name));
      for (const w of sorted) {
        if (toKeep.has(w.name)) continue;
        // Delete all files inside that week folder.
        const wRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${w.path}`, {
          headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
        });
        if (!wRes.ok) continue;
        const files = await wRes.json();
        for (const f of files) {
          await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${f.path}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${GH_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: `purge: retention ${RETENTION_WEEKS} weeks`,
              sha: f.sha,
              branch: 'main',
            }),
          });
          purgedCount++;
        }
      }
    }

    // 5. Log to Supabase.
    const finishedAt = new Date();
    await sbInsert('dr_snapshot_log', {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status: 'success',
      kind: 'scheduled',
      destination: `github:${GH_REPO}`,
      snapshot_path: ghPath,
      bytes_total: tarballBuf.length,
      tables_included: snap.tables_included,
      files_included: snap.files_included,
      checksum: sha256,
      detail: {
        duration_seconds: Math.round((finishedAt - startedAt) / 1000),
        github_commit_sha: putData.commit && putData.commit.sha,
        github_download_url: putData.content && putData.content.download_url,
        purged_files_older_than_retention: purgedCount,
      },
    });

    res.status(200).json({
      ok: true,
      snapshot_name: snap.snapshot_name,
      github_path: ghPath,
      bytes: tarballBuf.length,
      sha256,
      tables_included: snap.tables_included,
      files_included: snap.files_included,
      purged_files: purgedCount,
      duration_seconds: Math.round((finishedAt - startedAt) / 1000),
    });
  } catch (e) {
    try {
      await sbInsert('dr_snapshot_log', {
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        status: 'failed',
        kind: 'scheduled',
        destination: `github:${GH_REPO}`,
        error: e.message,
      });
    } catch (_) {}
    res.status(500).json({ error: 'Weekly snapshot failed', detail: e.message });
  }
};
