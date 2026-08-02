// GET /api/dashboard?ticker=MSFT&period=LTM_2026Q3
// Public endpoint — returns the JSON payload for /company.html.
// If `period` is omitted, returns the latest version for that ticker.
// Falls back to /public/companies/<ticker>.json if Supabase has no row,
// to keep the site working during the rollout window.

const fs = require('fs');
const path = require('path');
const { sbSelect } = require('./_supabase');

// Map pipeline_card_assets.kind → dashboard-JSON `documents.<key>` key.
// Any kind not listed here is ignored for the document panel.
const KIND_TO_DOC_KEY = {
  excel:              'valuationReportUrl',
  company_brief_pdf:  'companyBriefUrl',
  thesis_builder_pdf: 'thesisBuilderUrl',
  thesis_breaker_pdf: 'thesisBreakerUrl',
  munger_digital_pdf: 'mungerDigitalUrl',
};

async function signPipelineAsset(storagePath) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/pipeline-assets/${encodeURIComponent(storagePath).replace(/%2F/g, '/')}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${KEY}`,
          'apikey': KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl || ''}`;
  } catch (_) { return null; }
}

// Look up the latest active assets for a ticker in pipeline_card_assets
// and return { <docKey>: <signed url>, ... } for the panel in company.html.
async function fetchDocumentUrlsForTicker(ticker) {
  try {
    const assets = await sbSelect(
      'pipeline_card_assets',
      `select=kind,storage_path,uploaded_at&ticker=eq.${ticker}&active=eq.true&order=uploaded_at.desc`
    );
    if (!Array.isArray(assets) || !assets.length) return {};
    // Pick the most-recent active per kind (defensive; upload endpoint already dedupes).
    const byKind = {};
    for (const a of assets) {
      if (!byKind[a.kind]) byKind[a.kind] = a;
    }
    const out = {};
    await Promise.all(Object.entries(byKind).map(async ([kind, a]) => {
      const key = KIND_TO_DOC_KEY[kind];
      if (!key) return;
      const url = await signPipelineAsset(a.storage_path);
      if (url) out[key] = url;
    }));
    return out;
  } catch (e) {
    console.warn('[dashboard] doc-url lookup failed:', e.message);
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const ticker = String(req.query.ticker || '').toUpperCase().trim();
  const period = req.query.period ? String(req.query.period).trim() : null;

  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Try Supabase first
  if (hasSupabase) {
    try {
      let rows;
      if (period) {
        rows = await sbSelect(
          'company_dashboards',
          `select=ticker,fiscal_period,period_end_date,dashboard_json,excel_url,is_latest,notes&ticker=eq.${ticker}&fiscal_period=eq.${encodeURIComponent(period)}&limit=1`
        );
      } else {
        rows = await sbSelect(
          'company_dashboards',
          `select=ticker,fiscal_period,period_end_date,dashboard_json,excel_url,is_latest,notes&ticker=eq.${ticker}&is_latest=is.true&limit=1`
        );
      }
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        const payload = row.dashboard_json || {};
        // Inject version metadata so the frontend can render the banner/selector.
        payload.__version = {
          fiscal_period: row.fiscal_period,
          period_end_date: row.period_end_date,
          is_latest: row.is_latest,
          excel_url: row.excel_url,
          notes: row.notes,
        };
        // Resolve `documents.*` from the pipeline_card_assets bucket so the
        // Excel/PDF download buttons always point at the analyst's uploads,
        // not stale paths baked into the dashboard JSON.
        const docUrls = await fetchDocumentUrlsForTicker(ticker);
        if (Object.keys(docUrls).length) {
          payload.documents = { ...(payload.documents || {}), ...docUrls };
        }
        return res.status(200).json(payload);
      }
      // If period was specified but missing, return 404 explicitly.
      if (period) {
        return res.status(404).json({ error: `No data for ${ticker} ${period}` });
      }
      // Otherwise fall through to file fallback.
    } catch (err) {
      // Log only; fall through to file fallback.
      console.warn('[dashboard] Supabase lookup failed:', err.message);
    }
  }

  // Fallback: read from /public/companies/<ticker>.json
  try {
    const filePath = path.join(process.cwd(), 'public', 'companies', `${ticker.toLowerCase()}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.__version = { fiscal_period: null, period_end_date: null, is_latest: true, fallback: true };
    return res.status(200).json(data);
  } catch (err) {
    return res.status(404).json({ error: `No dashboard for ${ticker}` });
  }
};
