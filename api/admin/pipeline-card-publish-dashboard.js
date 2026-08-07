// ═══════════════════════════════════════════════════════════════════
// POST /api/admin/pipeline-card-publish-dashboard?card_id=<uuid>
//   Reads the active dashboard_json asset for the given card, validates
//   it, and publishes it to company_dashboards with is_latest=true.
//   Any prior versions for the ticker are demoted to is_latest=false.
//   Auth: admin or analyst.
// ═══════════════════════════════════════════════════════════════════

const { requireCapability } = require('../_require-capability');
const { sbSelect, sbInsert, sbUpsert, sbUpdate } = require('../_supabase');

const REQUIRED_FIELDS = ['ticker', 'name', 'valuationDate', 'fiscalYear'];

async function fetchStorageObject(storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error('Server not configured');
  const url = `${SUPABASE_URL}/storage/v1/object/pipeline-assets/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${KEY}`, 'apikey': KEY },
  });
  if (!r.ok) throw new Error(`Storage read failed: ${r.status}`);
  return await r.text();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireCapability(req, 'PL-09');
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const actor = auth.email || 'admin';

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const cardId = String(req.query.card_id || '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(cardId)) {
    res.status(400).json({ error: 'card_id (uuid) is required' });
    return;
  }

  try {
    // 1. Find the active dashboard_json asset for this card
    const assets = await sbSelect(
      'pipeline_card_assets',
      `select=id,ticker,storage_path,filename&card_id=eq.${cardId}&kind=eq.dashboard_json&active=eq.true&limit=1`
    );
    if (!assets || assets.length === 0) {
      res.status(400).json({ error: 'No dashboard_json asset uploaded for this card. Run the columbia-dashboard-converter skill and upload the .json file to slot 6 first.' });
      return;
    }
    const asset = assets[0];
    const cardTicker = String(asset.ticker || '').toUpperCase();

    // 2. Fetch the JSON bytes and parse
    let text;
    try { text = await fetchStorageObject(asset.storage_path); }
    catch (e) { res.status(500).json({ error: 'Failed to read JSON from storage', detail: e.message }); return; }

    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { res.status(400).json({ error: 'Uploaded file is not valid JSON', detail: e.message.slice(0, 200) }); return; }

    // 3. Validate schema
    const missing = REQUIRED_FIELDS.filter(f => payload[f] === undefined || payload[f] === null || payload[f] === '');
    if (missing.length) {
      res.status(400).json({ error: `Dashboard JSON missing required fields: ${missing.join(', ')}` });
      return;
    }

    const jsonTicker = String(payload.ticker || '').toUpperCase();
    if (jsonTicker !== cardTicker) {
      res.status(400).json({ error: `Ticker mismatch: card is ${cardTicker} but JSON has ${jsonTicker}` });
      return;
    }

    // 4. Determine fiscal_period + period_end_date. period_end_date is
    // NOT NULL in the DB so we always need a fallback — use today.
    const fiscalPeriod = String(payload.fiscalYear || 'LTM').slice(0, 40);
    let periodEndDate = null;
    if (payload.valuationDate) {
      const s = String(payload.valuationDate);
      // ISO first: "2026-05-05" or "2026-05-05T..."
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) periodEndDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
      else {
        // "05-May-2026" style
        const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
        if (m) {
          const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
          const mm = months[m[2].slice(0,1).toUpperCase() + m[2].slice(1,3).toLowerCase()];
          if (mm) periodEndDate = `${m[3]}-${mm}-${m[1].padStart(2,'0')}`;
        } else {
          // Last chance: let JS Date parse it (handles "May 5, 2026", "5/5/2026", etc.)
          const d = new Date(s);
          if (!Number.isNaN(d.getTime())) {
            periodEndDate = d.toISOString().slice(0, 10);
          }
        }
      }
    }
    // Ultimate fallback so the NOT NULL constraint never bites the analyst.
    if (!periodEndDate) periodEndDate = new Date().toISOString().slice(0, 10);

    // 5. Demote prior versions (only one lives per user request)
    try {
      await sbUpdate(
        'company_dashboards',
        `ticker=eq.${cardTicker}&is_latest=is.true`,
        { is_latest: false }
      );
    } catch (e) { console.warn('Demote prior failed (non-fatal):', e.message); }

    // 6. Upsert row. Only one version lives per (ticker, fiscal_period)
    // per the unique index company_dashboards_ticker_period_uniq, so we
    // upsert on that key. Publishing the same period again overwrites
    // the JSON payload and re-asserts is_latest=true.
    let inserted;
    try {
      const result = await sbUpsert(
        'company_dashboards',
        [{
          ticker: cardTicker,
          fiscal_period: fiscalPeriod,
          period_end_date: periodEndDate,
          dashboard_json: payload,
          excel_url: null,
          is_latest: true,
          notes: `Published from research card by ${actor} on ${new Date().toISOString().slice(0,10)}.`,
        }],
        'ticker,fiscal_period'
      );
      inserted = Array.isArray(result) ? result[0] : result;
    } catch (e) {
      res.status(500).json({ error: 'Upsert into company_dashboards failed', detail: String(e).slice(0, 200) });
      return;
    }

    res.status(200).json({
      ok: true,
      ticker: cardTicker,
      fiscal_period: fiscalPeriod,
      url: `/company.html?ticker=${encodeURIComponent(cardTicker)}`,
      row_id: inserted && inserted.id,
    });
  } catch (e) {
    res.status(500).json({ error: 'Publish failed', detail: String(e).slice(0, 200) });
  }
};
