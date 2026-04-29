// DCE Holdings — Study public read API
// GET /api/study?section=sector|megatrends
// Returns { items: [...], sections: [...] }

const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const section = (req.query.section || '').toString();
    let q = `select=id,section,title,slug,description,author,tags,storage_path,external_url,cover_emoji,published_at`;
    q += `&active=eq.true&order=published_at.desc.nullslast,id.desc&limit=200`;
    if (section === 'sector' || section === 'megatrends') {
      q += `&section=eq.${section}`;
    }

    const items = await sbSelect('study_articles', q);

    // Resolve PDF public URLs from storage paths
    const baseUrl = process.env.SUPABASE_URL || '';
    const out = items.map(it => ({
      ...it,
      pdf_url: it.storage_path ? `${baseUrl}/storage/v1/object/public/study/${it.storage_path}` : null,
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      items: out,
      sections: [
        { id: 'sector', label: 'Sector Analysis' },
        { id: 'megatrends', label: 'Megatrends' },
      ],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
