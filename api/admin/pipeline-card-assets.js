// GET  /api/admin/pipeline-card-assets?card_id=<uuid>
// DELETE /api/admin/pipeline-card-assets?id=<row_id>  (soft delete: active=false)
// Auth: admin or analyst.

const { requireRole } = require('../_require-role');
const { sbSelect, sbUpdate } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  if (!SUPABASE_URL) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  if (req.method === 'GET') {
    const cardId = (req.query.card_id || '').toString();
    if (!/^[0-9a-f-]{36}$/i.test(cardId)) {
      res.status(400).json({ error: 'card_id (uuid) is required' });
      return;
    }
    try {
      const items = await sbSelect(
        'pipeline_card_assets',
        `select=id,card_id,ticker,kind,filename,storage_path,size_bytes,mime_type,uploaded_by,uploaded_at,active` +
        `&card_id=eq.${cardId}&active=eq.true&order=kind.asc`
      );
      // Provide a signed URL for each so admin UI can preview/download.
      // Since bucket is private, we generate short-lived signed URLs.
      const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const withUrls = await Promise.all(items.map(async (it) => {
        try {
          const r = await fetch(
            `${SUPABASE_URL}/storage/v1/object/sign/pipeline-assets/${encodeURIComponent(it.storage_path).replace(/%2F/g, '/')}`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ expiresIn: 3600 }),
            }
          );
          if (r.ok) {
            const j = await r.json();
            return { ...it, signed_url: `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl || ''}` };
          }
        } catch (_) {}
        return it;
      }));
      res.status(200).json({ items: withUrls });
    } catch (e) {
      res.status(500).json({ error: 'List failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id || '').toString();
    if (!/^\d+$/.test(id)) {
      res.status(400).json({ error: 'id (numeric) is required' });
      return;
    }
    try {
      await sbUpdate('pipeline_card_assets', `id=eq.${id}`, { active: false });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Delete failed', detail: String(e).slice(0, 200) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
