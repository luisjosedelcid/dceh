// SEC EDGAR fetcher (no auth, public).
// Per SEC fair-use rules we must include a User-Agent that identifies us.
//
// Usage:
//   const { listFilings, fetchFiling, getCikForTicker } = require('./_edgar');
//   const cik = await getCikForTicker('MSFT');
//   const filings = await listFilings(cik, ['10-K','10-Q','8-K'], 5);
//   const text = await fetchFiling(cik, accessionNumber, primaryDoc);

'use strict';

const UA = 'DCE Holdings Investment Office luis@dceholdings.com';

// Cache for CIK lookups (in-memory per cold start)
let _tickerToCik = null;

async function loadTickerMap() {
  if (_tickerToCik) return _tickerToCik;
  // SEC publishes a ticker→CIK mapping at:
  // https://www.sec.gov/files/company_tickers.json
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`SEC ticker map failed: ${r.status}`);
  const data = await r.json();
  // shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const map = {};
  for (const k of Object.keys(data)) {
    const row = data[k];
    map[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
  }
  _tickerToCik = map;
  return map;
}

async function getCikForTicker(ticker) {
  const map = await loadTickerMap();
  return map[ticker.toUpperCase()] || null;
}

// List recent filings for a CIK, optionally filtered by form types.
async function listFilings(cik, formTypes = ['10-K','10-Q','8-K'], limit = 10) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`SEC submissions failed: ${r.status}`);
  const data = await r.json();
  const recent = data.filings && data.filings.recent;
  if (!recent) return [];
  const out = [];
  const wantSet = new Set(formTypes);
  for (let i = 0; i < (recent.form || []).length; i++) {
    if (!wantSet.has(recent.form[i])) continue;
    out.push({
      form: recent.form[i],
      filing_date: recent.filingDate[i],
      report_date: recent.reportDate[i] || null,
      accession_number: recent.accessionNumber[i],
      primary_document: recent.primaryDocument[i],
      primary_doc_description: recent.primaryDocDescription ? recent.primaryDocDescription[i] : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Fetch the raw HTML of a filing's primary document.
async function fetchFilingHtml(cik, accessionNumber, primaryDocument) {
  // Accession number with dashes removed in the URL path
  const accClean = accessionNumber.replace(/-/g, '');
  // CIK without leading zeros for the archive URL
  const cikInt = parseInt(cik, 10);
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accClean}/${primaryDocument}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!r.ok) throw new Error(`SEC filing fetch failed: ${r.status} ${url}`);
  return { url, html: await r.text() };
}

// Strip HTML tags and collapse whitespace.
function htmlToText(html) {
  if (!html) return '';
  // Drop script/style content first
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Replace block tags with newlines for readability
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|br)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n');
  // Strip inline tags WITHOUT inserting whitespace (avoids splitting words like
  // "RISK" into "RIS K" when an HTML span breaks them apart). For block tags
  // we already inserted newlines above.
  s = s.replace(/<\/(span|font|b|i|u|em|strong|a)>/gi, '');
  s = s.replace(/<(span|font|b|i|u|em|strong|a)\b[^>]*>/gi, '');
  // Strip remaining tags (replaced with space for safety)
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  s = s.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&#8217;|&rsquo;/g, "'")
       .replace(/&#8216;|&lsquo;/g, "'")
       .replace(/&#8220;|&ldquo;/g, '"')
       .replace(/&#8221;|&rdquo;/g, '"')
       .replace(/&#8211;|&ndash;/g, '-')
       .replace(/&#8212;|&mdash;/g, '--')
       .replace(/&quot;/g, '"')
       .replace(/&#39;|&apos;/g, "'");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Try to locate "Risk Factors" section in 10-K / 10-Q text.
// Returns the section as plain text or null if not found.
//
// IMPORTANT: SEC HTML often inserts <span>/<font> tags inside words, so when
// stripped to text we get artefacts like "RIS K FACTORS". The regex below
// tolerates an optional internal space inside RISK and FACTORS.
function extractRiskFactors(text) {
  if (!text) return null;
  // Match "Item 1A. Risk Factors" with optional broken whitespace inside words.
  const startRe = /Item\s+1A\s*[\.:\-]?\s*Ris\s?k\s+Fact\s?ors/i;
  // Find the LAST occurrence (the heading appears once in TOC, once at the
  // actual section — the section is later in the doc and has more body after).
  let m;
  let lastIdx = -1;
  const re = new RegExp(startRe, 'gi');
  while ((m = re.exec(text)) !== null) {
    lastIdx = m.index;
  }
  if (lastIdx === -1) return null;
  const start = lastIdx;
  // End: next "Item 1B", "Item 2", "Unresolved Staff Comments", or end-of-doc
  const endRe = /Item\s+(1B|2|3|4|5|7)\b/i;
  const tail = text.slice(start + 200); // skip the heading itself
  const em = endRe.exec(tail);
  const end = em ? (start + 200 + em.index) : Math.min(start + 120000, text.length);
  return text.slice(start, end).trim();
}

// Try to locate MD&A section (Item 2 in 10-Q, Item 7 in 10-K).
// Pick the LAST occurrence to skip Table of Contents entries.
function extractMDA(text) {
  if (!text) return null;
  const re = /(Management['\u2019]s\s+Discussion\s+and\s+Analysis)/gi;
  let m, lastIdx = -1;
  while ((m = re.exec(text)) !== null) {
    lastIdx = m.index;
  }
  if (lastIdx === -1) return null;
  const start = lastIdx;
  // End: next major Item heading or 120k chars
  const endRe = /Item\s+(3|4|7A|8|9)\b/i;
  const tail = text.slice(start + 500);
  const em = endRe.exec(tail);
  const end = em ? (start + 500 + em.index) : Math.min(start + 120000, text.length);
  return text.slice(start, end).trim();
}

// For 8-K — extract the press release / item content.
// 8-Ks typically have Item 2.02 "Results of Operations" for earnings.
function extractEightKContent(text) {
  if (!text) return null;
  // Drop the boilerplate header (Form 8-K, Commission File Number, etc.) by jumping to "Item"
  const m = /Item\s+\d+\.\d+/i.exec(text);
  if (!m) return text.slice(0, 30000);
  return text.slice(m.index, m.index + 30000).trim();
}

module.exports = {
  getCikForTicker,
  listFilings,
  fetchFilingHtml,
  htmlToText,
  extractRiskFactors,
  extractMDA,
  extractEightKContent,
};
