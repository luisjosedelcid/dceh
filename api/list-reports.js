// GET /api/list-reports?folder=monthly|committee|annual
// Public endpoint — used by reporting.html to render file lists.
// Returns: { files: [{ name, size, updated_at, url }] }

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const folder = (req.query.folder || '').toString();
  if (!['monthly', 'committee', 'annual'].includes(folder)) {
    res.status(400).json({ error: 'Invalid folder' });
    return;
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: folder + '/',
        limit: 100,
        sortBy: { column: 'name', order: 'desc' },
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      res.status(502).json({ error: 'Supabase error', detail: txt.slice(0, 200) });
      return;
    }

    const data = await r.json();
    const files = (data || [])
      .filter(o => o.name && !o.name.endsWith('/') && o.id !== null)
      .map(o => ({
        name: o.name,
        size: o.metadata?.size || 0,
        updated_at: o.updated_at,
        url: `${SUPABASE_URL}/storage/v1/object/public/reports/${folder}/${encodeURIComponent(o.name)}`,
      }));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ files });
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed', detail: String(e).slice(0, 200) });
  }
};
