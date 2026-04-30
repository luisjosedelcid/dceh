// Document ingestion pipeline for pre-mortem qualitative_llm triggers.
//
// For a given ticker, fetches the latest filings from EDGAR (10-K, 10-Q, 8-K)
// and persists them into source_documents (parsed_summary contains the
// extracted Risk Factors / MD&A / 8-K content sections).
//
// Idempotent: uses (ticker, doc_type, period_end) unique partial index to
// upsert. Sections are limited in length to avoid bloating the DB.

'use strict';

const { sbSelect, sbUpsert } = require('./_supabase');
const {
  getCikForTicker,
  listFilings,
  fetchFilingHtml,
  htmlToText,
  extractRiskFactors,
  extractMDA,
  extractEightKContent,
} = require('./_edgar');

const FORM_TO_DOCTYPE = {
  '10-K': '10-K',
  '10-Q': '10-Q',
  '8-K': '8-K',
};

// Truncate a string while keeping the start (most recent paragraphs in EDGAR
// docs are usually closer to the start of each section).
function trunc(s, max) {
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n... [truncated, full doc available at source_url]';
}

async function ingestTicker(ticker, { limitPerForm = 2, force = false } = {}) {
  ticker = String(ticker).toUpperCase();
  const cik = await getCikForTicker(ticker);
  if (!cik) {
    return { ticker, ok: false, error: 'CIK not found for ticker' };
  }

  // Get up to N most recent filings of each form type
  const wanted = ['10-K', '10-Q', '8-K'];
  const all = await listFilings(cik, wanted, 30); // up to 30 most recent across all wanted forms
  // Group by form, keep N most recent per form
  const buckets = new Map();
  for (const f of all) {
    if (!buckets.has(f.form)) buckets.set(f.form, []);
    if (buckets.get(f.form).length < limitPerForm) buckets.get(f.form).push(f);
  }
  const targets = [];
  for (const arr of buckets.values()) targets.push(...arr);

  // Check which we already have ingested (skip if same period_end + doc_type)
  const periods = targets.map(f => f.report_date).filter(Boolean);
  let existingKeys = new Set();
  if (periods.length > 0) {
    const inList = periods.map(p => `"${p}"`).join(',');
    const existing = await sbSelect(
      'source_documents',
      `select=ticker,doc_type,period_end&ticker=eq.${ticker}&period_end=in.(${inList})`
    );
    existingKeys = new Set(existing.map(r => `${r.ticker}|${r.doc_type}|${r.period_end}`));
  }

  const ingested = [];
  const skipped = [];
  const errors = [];

  for (const f of targets) {
    const docType = FORM_TO_DOCTYPE[f.form];
    if (!docType) continue;
    const key = `${ticker}|${docType}|${f.report_date}`;
    if (existingKeys.has(key) && !force) {
      skipped.push({ ...f, reason: 'already ingested' });
      continue;
    }

    try {
      const { url, html } = await fetchFilingHtml(cik, f.accession_number, f.primary_document);
      const text = htmlToText(html);

      const summary = {};
      if (docType === '10-K' || docType === '10-Q') {
        const rf = extractRiskFactors(text);
        const mda = extractMDA(text);
        if (rf) summary.risk_factors = trunc(rf, 30000);
        if (mda) summary.mda = trunc(mda, 30000);
      } else if (docType === '8-K') {
        const content = extractEightKContent(text);
        if (content) summary.content = trunc(content, 25000);
      }

      summary.full_text_length = text.length;
      summary.extracted_at = new Date().toISOString();

      const row = {
        ticker,
        doc_type: docType,
        period_end: f.report_date,
        filed_at: f.filing_date,
        source_url: url,
        source_provider: 'sec_edgar',
        raw_text: trunc(text, 200000), // store up to 200k of cleaned text
        parsed_summary: summary,
        diff_vs_prior: null,
        fetched_at: new Date().toISOString(),
        fetched_by: 'system',
      };

      const inserted = await sbUpsert('source_documents', [row], 'ticker,doc_type,period_end');
      const insertedRow = Array.isArray(inserted) ? inserted[0] : inserted;

      // Create reunderwriting_due for 10-K / 10-Q (skip 8-K — those are too
      // frequent and not natural re-underwriting triggers). Idempotent via
      // unique constraint on (ticker, period_end, doc_type).
      if (docType === '10-K' || docType === '10-Q') {
        try {
          await sbUpsert('reunderwriting_due', [{
            ticker,
            period_end: f.report_date,
            doc_type: docType,
            source_doc_id: insertedRow ? insertedRow.id : null,
            status: 'pending',
            due_at: new Date().toISOString(),
          }], 'ticker,period_end,doc_type');
        } catch (eDue) {
          // Don't fail the ingest if due creation fails
          console.error('reunderwriting_due upsert failed', eDue.message);
        }
      }

      ingested.push({
        form: f.form,
        period_end: f.report_date,
        filing_date: f.filing_date,
        url,
        sections: Object.keys(summary).filter(k => k !== 'full_text_length' && k !== 'extracted_at'),
        text_length: text.length,
      });
    } catch (e) {
      errors.push({ form: f.form, period_end: f.report_date, error: String(e.message || e).slice(0, 300) });
    }
  }

  return { ticker, cik, ok: true, ingested, skipped, errors };
}

// Ingest all tickers that have an active premortem.
async function ingestAllActive(opts = {}) {
  // opts may include { limitPerForm, force }
  const pms = await sbSelect('premortems', 'select=ticker&status=eq.active');
  const tickers = Array.from(new Set(pms.map(p => p.ticker)));
  const results = [];
  for (const t of tickers) {
    try {
      results.push(await ingestTicker(t, opts));
    } catch (e) {
      results.push({ ticker: t, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return { tickers, results };
}

module.exports = { ingestTicker, ingestAllActive };
