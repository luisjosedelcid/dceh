// Pre-mortem qualitative_llm trigger evaluator.
//
// For each `qualitative_llm` failure_mode, gather the most recent ingested
// source_documents for the ticker, then ask Claude (haiku-class model) to
// judge whether the failure mode is now triggered.
//
// trigger_config schema (qualitative_llm):
//   {
//     check: 'llm_judgment',
//     sources: ['10-Q','10-K','8-K','earnings_call'],   // doc_types to consider
//     window_days?: 180,                                 // only consider docs newer than N days (default 365)
//     prompt_extra?: 'string'                            // additional prompt context
//   }

'use strict';

const { sbSelect } = require('./_supabase');

const DEFAULT_MODEL = 'claude-haiku-4-5'; // cheap + fast
const MAX_DOC_CHARS = 25000;              // truncate each doc section sent to LLM

// Map logical source names from trigger_config to actual doc_type values
// stored in source_documents. 'earnings_call' -> 8-K (which holds the earnings
// press release + transcript exhibits in EDGAR).
function mapSources(sources) {
  const types = (sources && sources.length) ? sources : ['10-Q','10-K','8-K'];
  const mapped = new Set();
  for (const s of types) {
    if (s === 'earnings_call' || s === 'earnings_press_release' || s === 'press_release') {
      mapped.add('8-K');
    } else {
      mapped.add(s);
    }
  }
  return Array.from(mapped);
}

async function gatherDocs(ticker, sources, windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (windowDays || 365));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const types = mapSources(sources);
  const inList = types.map(t => `"${t}"`).join(',');

  const docs = await sbSelect(
    'source_documents',
    `select=id,doc_type,period_end,filed_at,source_url,parsed_summary&ticker=eq.${ticker}&doc_type=in.(${inList})&period_end=gte.${cutoffIso}&order=period_end.desc&limit=8`
  );
  return docs;
}

function packSummaryForPrompt(doc) {
  const s = doc.parsed_summary || {};
  let blob = '';
  if (s.risk_factors) blob += `\n=== RISK FACTORS (Item 1A) ===\n${s.risk_factors}`;
  if (s.mda)          blob += `\n=== MD&A ===\n${s.mda}`;
  if (s.content)      blob += `\n=== CONTENT ===\n${s.content}`;
  if (!blob && doc.parsed_summary) {
    // Fallback: stringify whatever we have
    blob = JSON.stringify(s).slice(0, MAX_DOC_CHARS);
  }
  return blob.slice(0, MAX_DOC_CHARS);
}

function buildPrompt({ ticker, failureMode, docs, promptExtra }) {
  const lines = [];
  lines.push(`You are a sell-side risk analyst evaluating a pre-mortem failure mode for ${ticker}.`);
  lines.push('');
  lines.push(`# Failure mode being evaluated`);
  lines.push(`"${failureMode}"`);
  if (promptExtra) {
    lines.push('');
    lines.push(`# Additional context`);
    lines.push(promptExtra);
  }
  lines.push('');
  lines.push(`# Recent SEC filings & disclosures for ${ticker}`);
  for (const d of docs) {
    lines.push('');
    lines.push(`## ${d.doc_type} for period ending ${d.period_end} (filed ${d.filed_at})`);
    lines.push(`Source: ${d.source_url}`);
    lines.push(packSummaryForPrompt(d));
  }
  lines.push('');
  lines.push(`# Task`);
  lines.push(`Carefully read the disclosures above and decide whether the failure mode is now TRIGGERED, still under MONITORING, or RESOLVED.`);
  lines.push(`A failure mode is TRIGGERED only if the disclosures contain concrete, specific evidence (numbers, named programs, explicit guidance shifts, regulatory actions, etc.) consistent with the failure mode happening or being imminent. Vague boilerplate risk language is NOT enough.`);
  lines.push('');
  lines.push(`Respond ONLY with valid JSON in this exact schema:`);
  lines.push(`{
  "status": "triggered" | "monitoring" | "resolved",
  "confidence": "low" | "medium" | "high",
  "evidence": "<1-3 sentence summary citing specific phrases or numbers from the docs>",
  "key_quotes": ["<exact quote 1>", "<exact quote 2>"]
}`);
  lines.push(``);
  lines.push(`Be conservative — only mark TRIGGERED when the evidence is unambiguous.`);
  return lines.join('\n');
}

async function callClaude(prompt, model) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Claude error ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  // data.content = [{ type:'text', text:'...' }]
  const text = (data.content || []).map(c => c.text || '').join('').trim();
  return { text, usage: data.usage || null, model: data.model || model };
}

function parseLlmJson(text) {
  if (!text) return null;
  // Strip code fences if present
  let s = text.trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  // Find first { ... } JSON block
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

// Evaluate a single qualitative_llm failure_mode. Returns the same shape as
// quantitative evaluators in _premortem-eval.js.
async function evaluateLlmTrigger(fm, ticker) {
  const cfg = fm.trigger_config || {};
  const sources = cfg.sources || ['10-K', '10-Q', '8-K'];
  const windowDays = cfg.window_days || 365;

  const docs = await gatherDocs(ticker, sources, windowDays);
  if (docs.length === 0) {
    return {
      status: 'error',
      evidence: 'No source documents ingested yet for this ticker. Run /api/admin-ingest-docs first.',
      llm_response: null,
      source_doc_ids: [],
    };
  }

  const prompt = buildPrompt({
    ticker,
    failureMode: fm.failure_mode,
    docs,
    promptExtra: cfg.prompt_extra,
  });

  let llm;
  try {
    llm = await callClaude(prompt);
  } catch (e) {
    return {
      status: 'error',
      evidence: `LLM call failed: ${String(e.message || e).slice(0, 200)}`,
      llm_response: null,
      source_doc_ids: docs.map(d => d.id),
    };
  }

  const parsed = parseLlmJson(llm.text);
  if (!parsed || !parsed.status) {
    return {
      status: 'error',
      evidence: `LLM returned unparseable response: ${llm.text.slice(0, 200)}`,
      llm_response: { raw: llm.text, usage: llm.usage, model: llm.model },
      source_doc_ids: docs.map(d => d.id),
    };
  }

  const status = parsed.status === 'triggered' ? 'triggered'
                : parsed.status === 'resolved' ? 'resolved'
                : 'monitoring';

  // Build evidence string with confidence + key quotes
  let evidence = parsed.evidence || 'No evidence summary returned.';
  if (parsed.confidence) evidence += ` [confidence: ${parsed.confidence}]`;
  if (Array.isArray(parsed.key_quotes) && parsed.key_quotes.length > 0) {
    evidence += ` Quotes: ${parsed.key_quotes.slice(0,2).map(q => `"${String(q).slice(0,160)}"`).join(' | ')}`;
  }

  return {
    status,
    evidence,
    llm_response: { parsed, raw: llm.text, usage: llm.usage, model: llm.model },
    source_doc_ids: docs.map(d => d.id),
    docs_considered: docs.map(d => ({ id: d.id, doc_type: d.doc_type, period_end: d.period_end })),
  };
}

module.exports = { evaluateLlmTrigger, callClaude, gatherDocs, mapSources };
