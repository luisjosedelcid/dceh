// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Pipeline Card Asset upload (admin + analyst)
// ───────────────────────────────────────────────────────────────────
// POST /api/admin/pipeline-card-upload?card_id=<uuid>&kind=<slot>&filename=<name>
// Body: raw file bytes
// Header: x-admin-token: <token>
//
// Slots (kind):
//   - excel                → .xlsx / .xls
//   - company_brief_pdf    → .pdf
//   - thesis_builder_pdf   → .pdf
//   - thesis_breaker_pdf   → .pdf
//   - dashboard_html       → .html / .htm
//
// Behavior:
//   1. Auth: role must be admin or analyst.
//   2. Validate card exists (fetch ticker).
//   3. Validate extension matches slot.
//   4. Upload bytes to bucket 'pipeline-assets' at {card_id}/{kind}/{ts}__{filename}.
//   5. Soft-deactivate any previously-active row for (card_id, kind).
//   6. Insert new row with active=true.
//   7. Return { ok, item }.
// ═══════════════════════════════════════════════════════════════════

const { requireRole } = require('../_require-role');
const { sbSelect, sbInsert, sbUpdate } = require('../_supabase');
const { mirrorPipelineToDataroom, removeDataroomMirror } = require('../_pipeline_dataroom_mirror');

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (Vercel serverless hard cap)

const SLOT_EXTENSIONS = {
  excel: /\.(xlsx|xls)$/i,
  company_brief_pdf: /\.pdf$/i,
  thesis_builder_pdf: /\.pdf$/i,
  thesis_breaker_pdf: /\.pdf$/i,
  munger_digital_pdf: /\.pdf$/i,
  dashboard_html: /\.(html|htm)$/i,
};

const SLOT_MIMES = {
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  company_brief_pdf: 'application/pdf',
  thesis_builder_pdf: 'application/pdf',
  thesis_breaker_pdf: 'application/pdf',
  munger_digital_pdf: 'application/pdf',
  dashboard_html: 'text/html',
};

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 200);
}

function nowUnix() { return Math.floor(Date.now() / 1000); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const actor = auth.user.email;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // ── Validate query params ─────────────────────────────────────
  const cardId = (req.query.card_id || '').toString();
  if (!/^[0-9a-f-]{36}$/i.test(cardId)) {
    res.status(400).json({ error: 'card_id (uuid) is required' });
    return;
  }

  const kind = (req.query.kind || '').toString();
  if (!SLOT_EXTENSIONS[kind]) {
    res.status(400).json({ error: `kind must be one of: ${Object.keys(SLOT_EXTENSIONS).join(', ')}` });
    return;
  }

  const filename = sanitizeFilename(req.query.filename || '');
  if (!filename) {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  if (!SLOT_EXTENSIONS[kind].test(filename)) {
    res.status(400).json({ error: `filename extension does not match kind '${kind}'` });
    return;
  }

  // ── Fetch card to get ticker ───────────────────────────────────
  const cards = await sbSelect('pipeline_cards', `select=id,ticker,name&id=eq.${cardId}&limit=1`);
  if (!cards.length) {
    res.status(404).json({ error: 'card not found' });
    return;
  }
  const card = cards[0];
  const ticker = card.ticker;

  // ── Read body ─────────────────────────────────────────────────
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      res.status(413).json({ error: 'File too large (max 25 MB)' });
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  // ── Upload to Supabase Storage bucket 'pipeline-assets' ───────
  const ts = nowUnix();
  const storagePath = `${cardId}/${kind}/${ts}__${filename}`;
  const uploadUrl   = `${SUPABASE_URL}/storage/v1/object/pipeline-assets/${storagePath}`;
  const mime        = SLOT_MIMES[kind];

  try {
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body,
    });
    if (!r.ok) {
      const txt = await r.text();
      res.status(502).json({ error: 'Upload failed', detail: txt.slice(0, 200) });
      return;
    }
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', detail: String(e).slice(0, 200) });
    return;
  }

  // ── Deactivate any previous active row for (card_id, kind) ─────
  try {
    // Look up prior actives so we can remove their dataroom mirrors after deactivating
    const prior = await sbSelect(
      'pipeline_card_assets',
      `select=id,mirror_id&card_id=eq.${cardId}&kind=eq.${kind}&active=eq.true`
    );
    await sbUpdate(
      'pipeline_card_assets',
      `card_id=eq.${cardId}&kind=eq.${kind}&active=eq.true`,
      { active: false }
    );
    for (const p of (prior || [])) {
      if (p.mirror_id) {
        try { await removeDataroomMirror(p.mirror_id); } catch (e) { console.warn('mirror cleanup failed:', e.message); }
      }
    }
  } catch (e) {
    // Non-fatal; the unique partial index would surface a conflict on insert if any
    console.error('Failed to deactivate prior assets:', e.message);
  }

  // ── Insert new row ─────────────────────────────────────────────
  let item;
  try {
    const result = await sbInsert('pipeline_card_assets', {
      card_id: cardId,
      ticker,
      kind,
      filename,
      storage_path: storagePath,
      size_bytes: body.length,
      mime_type: mime,
      uploaded_by: actor,
      active: true,
    });
    item = Array.isArray(result) ? result[0] : result;
  } catch (e) {
    res.status(500).json({ error: 'Metadata insert failed', detail: String(e).slice(0, 200) });
    return;
  }

  // Mirror to Data Room (best-effort; don't fail the upload if this trips)
  try {
    await mirrorPipelineToDataroom(item);
  } catch (e) {
    console.warn('Data Room mirror failed:', e.message);
  }

  res.status(200).json({ ok: true, item });
};

module.exports.config = {
  api: { bodyParser: false },
};
