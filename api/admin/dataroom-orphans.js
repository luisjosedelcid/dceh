// GET    /api/admin/dataroom-orphans        — list current orphan dataroom_files
// DELETE /api/admin/dataroom-orphans        — purge all orphan rows
// DELETE /api/admin/dataroom-orphans?id=UUID — purge single row (must be orphan)
//
// A row is "orphan" when dataroom_files.storage_path does not resolve to an
// actual object in the `dataroom` Supabase Storage bucket. Orphans are the
// leftovers of files that were deleted from the bucket without their row
// being cleaned up — they cause `copy failed` errors in the nightly backup.
//
// Auth: admin token via x-admin-token header.

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbDelete } = require('../_supabase.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function headStorageObject(bucket, path) {
  // HEAD via GET with range 0-0 is the cheapest way to probe existence.
  // Storage's /object/info endpoint returns 200 with metadata or 400/404.
  const url = `${SUPABASE_URL}/storage/v1/object/info/${bucket}/${encodeURI(path)}`;
  try {
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
      },
    });
    if (r.ok) return { exists: true };
    if (r.status === 404 || r.status === 400) return { exists: false, status: r.status };
    return { exists: null, status: r.status };  // unknown
  } catch (e) {
    return { exists: null, error: String(e).slice(0, 200) };
  }
}

async function scanOrphans(limit) {
  // Pull all rows (or a limit), probe each. dataroom_files is small (~O(200))
  // so linear scan is fine.
  const query = `select=id,storage_path,filename,name,folder_id,uploaded_at,size_bytes&order=uploaded_at.desc${limit ? `&limit=${limit}` : ''}`;
  const rows = await sbSelect('dataroom_files', query);
  const orphans = [];
  const unknown = [];
  for (const r of rows) {
    if (!r.storage_path) {
      orphans.push({ ...r, reason: 'null storage_path' });
      continue;
    }
    const probe = await headStorageObject('dataroom', r.storage_path);
    if (probe.exists === false) {
      orphans.push({ ...r, reason: `HTTP ${probe.status}` });
    } else if (probe.exists === null) {
      unknown.push({ ...r, reason: probe.error || `HTTP ${probe.status}` });
    }
  }
  return { orphans, unknown, total_scanned: rows.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Supabase not configured' });
    return;
  }

  const decoded = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!decoded) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const limit = Number(req.query?.limit) > 0 ? Number(req.query.limit) : null;
      const result = await scanOrphans(limit);
      res.status(200).json({
        ok: true,
        total_scanned: result.total_scanned,
        orphan_count: result.orphans.length,
        unknown_count: result.unknown.length,
        orphans: result.orphans,
        unknown: result.unknown,
      });
    } catch (e) {
      res.status(500).json({ error: 'Scan failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const specificId = req.query?.id;

    try {
      if (specificId) {
        // Single-row delete: verify it's actually orphan before deleting.
        const rows = await sbSelect('dataroom_files', `select=id,storage_path&id=eq.${specificId}`);
        if (!rows.length) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const row = rows[0];
        if (row.storage_path) {
          const probe = await headStorageObject('dataroom', row.storage_path);
          if (probe.exists === true) {
            res.status(409).json({ error: 'File still exists in bucket — not an orphan', storage_path: row.storage_path });
            return;
          }
        }
        await sbDelete('dataroom_files', `id=eq.${specificId}`);
        res.status(200).json({ ok: true, deleted: [{ id: specificId, storage_path: row.storage_path }] });
        return;
      }

      // Bulk purge: rescan first, then delete only current orphans.
      const { orphans } = await scanOrphans(null);
      if (!orphans.length) {
        res.status(200).json({ ok: true, deleted: [], message: 'No orphans found' });
        return;
      }
      const ids = orphans.map(o => o.id);
      // sbDelete with in.() filter
      await sbDelete('dataroom_files', `id=in.(${ids.join(',')})`);
      res.status(200).json({
        ok: true,
        deleted_count: orphans.length,
        deleted: orphans.map(o => ({ id: o.id, storage_path: o.storage_path, filename: o.filename })),
      });
    } catch (e) {
      res.status(500).json({ error: 'Delete failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
