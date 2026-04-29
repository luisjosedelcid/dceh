// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Idea Feed cron
// GET /api/cron/refresh-feed
//   - Reads active sources from idea_feed_sources
//   - Fetches each RSS/Atom feed
//   - For each NEW item: extracts tickers (regex first, LLM fallback)
//   - Inserts into idea_feed_items (idempotent via (source_id, guid))
//
// Triggered by Vercel cron every 6h (see vercel.json crons).
// Auth: requires header `x-cron-secret` matching CRON_SECRET env var,
// OR Vercel-injected `x-vercel-cron: 1` header (Vercel cron requests).
// ═══════════════════════════════════════════════════════════════════

const { sbSelect, sbInsert, sbHeaders, sbBaseUrl } = require('../_supabase.js');

// ── Ticker extraction ──────────────────────────────────────────────
// Regex 1: $TICKER (1-5 uppercase letters, optional .X suffix like .B)
const RX_DOLLAR = /\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
// Regex 2: (TICKER) or (NYSE:TICKER) / (NASDAQ:TICKER) inline mentions
const RX_PAREN  = /\(([A-Z]{1,5}(?:\.[A-Z])?)\)/g;
const RX_EXCH   = /\b(?:NYSE|NASDAQ|NASDAQGS|NASDAQGM):\s?([A-Z]{1,5}(?:\.[A-Z])?)\b/g;

// Common false positives (English/Spanish stop-acronyms, currencies, etc.)
const STOP = new Set([
  'A','I','U','THE','AND','OR','FOR','NOT','BUT','OUT','ALL','NEW','OLD','BIG',
  'CEO','CFO','COO','CTO','CIO','CMO','EVP','SVP','VP','IPO','SPAC','M&A','LBO',
  'GAAP','EBIT','ROIC','ROE','ROA','EPS','PE','PB','PEG','FCF','DCF','TAM','SAM',
  'USD','EUR','GBP','JPY','CHF','CAD','MXN','AUD','HKD','CNY','BRL','CLP','INR',
  'API','SDK','SaaS','AI','ML','LLM','GPU','CPU','RAM','SSD','HDD','OS','UI','UX',
  'SEC','FDA','FTC','DOJ','IRS','EPA','EU','UN','UK','US','USA','GDP','CPI','PPI',
  'YOY','QOQ','YTD','MTD','LTM','NTM','LFY','FY','Q1','Q2','Q3','Q4','H1','H2',
  'OK','PDF','CSV','HTML','CSS','XML','JSON','URL','HTTP','HTTPS','RSS',
  'NYSE','NASDAQ','LSE','TSX','AMEX','OTC','ETF','REIT','MLP','SPV',
  // common words that match the regex when written in caps (rare in our feeds)
  'TIME','LIFE','CASH','BANK','RICE','OPEN','PLAY','HOME','LIVE','TRUE',
]);

function extractTickersRegex(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  while ((m = RX_DOLLAR.exec(text)) !== null) found.add(m[1]);
  while ((m = RX_EXCH.exec(text))   !== null) found.add(m[1]);
  while ((m = RX_PAREN.exec(text))  !== null) {
    const t = m[1];
    // Only accept paren-tickers that appear near "ticker"/"NYSE"/"NASDAQ"
    // OR are 3-5 letters and not in stop list. To stay conservative, require
    // adjacent exchange context within 40 chars before the match.
    const start = Math.max(0, m.index - 40);
    const ctx = text.slice(start, m.index).toUpperCase();
    if (/NYSE|NASDAQ|TICKER|TKR|SYMBOL/.test(ctx)) found.add(t);
  }
  // Filter stops
  return [...found].filter(t => !STOP.has(t));
}

// ── LLM fallback (Anthropic) ───────────────────────────────────────
async function extractTickersLLM(title, snippet) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const prompt = `From the following blog/podcast post, list any publicly-traded US/EU stock tickers (NYSE/NASDAQ/Euronext) that are clearly the SUBJECT of analysis (not just casual mentions). Reply with ONLY a JSON array of uppercase tickers, e.g. ["AAPL","MSFT"]. If none, reply [].

TITLE: ${title}

EXCERPT: ${(snippet || '').slice(0, 1500)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      console.error('LLM HTTP', r.status, errTxt.slice(0, 200));
      return [];
    }
    const j = await r.json();
    const txt = j?.content?.[0]?.text?.trim() || '[]';
    // Find first JSON array in response
    const match = txt.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(t => typeof t === 'string')
      .map(t => t.toUpperCase().trim())
      .filter(t => /^[A-Z]{1,5}(\.[A-Z])?$/.test(t))
      .filter(t => !STOP.has(t));
  } catch (e) {
    console.error('LLM extract error:', e.message);
    return [];
  }
}

// ── RSS / Atom parser (lightweight, regex-based) ──────────────────
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}
function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function pickTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}
function pickAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function parseFeed(xml) {
  // Returns array of { guid, url, title, snippet, published_at }
  const out = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 800));
  if (isAtom) {
    const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    for (const e of entries) {
      const id = pickTag(e, 'id');
      const title = stripHtml(pickTag(e, 'title')).slice(0, 500);
      const link = pickAttr(e, 'link', 'href') || pickTag(e, 'link');
      const summary = stripHtml(pickTag(e, 'summary') || pickTag(e, 'content')).slice(0, 800);
      const pub = pickTag(e, 'updated') || pickTag(e, 'published');
      out.push({
        guid: id || link,
        url: link,
        title,
        snippet: summary,
        published_at: pub ? new Date(pub).toISOString() : null,
      });
    }
  } else {
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const it of items) {
      const guid = pickTag(it, 'guid') || pickTag(it, 'link');
      const link = pickTag(it, 'link') || guid;
      const title = stripHtml(pickTag(it, 'title')).slice(0, 500);
      const desc = stripHtml(pickTag(it, 'description') || pickTag(it, 'content:encoded')).slice(0, 800);
      const pub = pickTag(it, 'pubDate') || pickTag(it, 'dc:date');
      out.push({
        guid: guid || link,
        url: link,
        title,
        snippet: desc,
        published_at: pub ? (isNaN(Date.parse(pub)) ? null : new Date(pub).toISOString()) : null,
      });
    }
  }
  return out;
}

// ── Existing-guid lookup (avoid re-inserting) ─────────────────────
async function fetchExistingGuids(sourceId) {
  // Only check most recent 200 rows to keep request small
  const q = `select=guid&source_id=eq.${sourceId}&order=fetched_at.desc&limit=200`;
  try {
    const rows = await sbSelect('idea_feed_items', q);
    return new Set(rows.map(r => r.guid));
  } catch (e) {
    console.error('fetchExistingGuids:', e.message);
    return new Set();
  }
}

// ── Main handler ───────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Auth: Vercel cron OR shared secret
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();
  const summary = { sources: 0, fetched: 0, new_items: 0, llm_calls: 0, errors: [] };

  try {
    const sources = await sbSelect(
      'idea_feed_sources',
      'select=id,name,rss_url,is_paid&active=eq.true&order=name.asc'
    );
    summary.sources = sources.length;

    for (const src of sources) {
      try {
        const r = await fetch(src.rss_url, {
          headers: { 'User-Agent': 'DCE-Holdings-IdeaFeed/1.0 (+https://www.dceholdings.app)' },
          // 25s budget
        });
        if (!r.ok) {
          summary.errors.push(`${src.name}: HTTP ${r.status}`);
          continue;
        }
        const xml = await r.text();
        const items = parseFeed(xml);
        summary.fetched += items.length;

        const existing = await fetchExistingGuids(src.id);
        // Only consider items from last 60 days, max 25 per source per run
        const cutoff = Date.now() - 60 * 86400 * 1000;
        const fresh = items
          .filter(it => it.guid && !existing.has(it.guid))
          .filter(it => {
            if (!it.published_at) return true; // keep if missing date
            const t = Date.parse(it.published_at);
            return Number.isFinite(t) && t >= cutoff;
          })
          .slice(0, 25);

        for (const it of fresh) {
          let tickers = extractTickersRegex(`${it.title}\n\n${it.snippet}`);
          let method = 'regex';
          if (tickers.length === 0 && summary.llm_calls < 30) {
            // LLM fallback (capped per run to control cost)
            tickers = await extractTickersLLM(it.title, it.snippet);
            summary.llm_calls += 1;
            method = tickers.length > 0 ? 'llm' : 'none';
          }

          try {
            await sbInsert('idea_feed_items', {
              source_id: src.id,
              guid: it.guid,
              url: it.url || null,
              title: it.title || '(untitled)',
              snippet: (it.snippet || '').slice(0, 500),
              published_at: it.published_at || null,
              tickers,
              extraction_method: method,
            });
            summary.new_items += 1;
          } catch (e) {
            // Most likely a unique-constraint race; ignore
            if (!/duplicate|unique/i.test(e.message)) {
              summary.errors.push(`${src.name} insert: ${e.message.slice(0, 120)}`);
            }
          }
        }
      } catch (e) {
        summary.errors.push(`${src.name}: ${e.message.slice(0, 120)}`);
      }
    }

    summary.ms = Date.now() - startedAt;
    res.status(200).json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message, summary });
  }
};
