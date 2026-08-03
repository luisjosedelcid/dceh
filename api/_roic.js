// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — ROIC.ai API helper
// ───────────────────────────────────────────────────────────────────
// Central helper for talking to ROIC.ai (Individual plan, 300 req/min).
// v2 endpoints use ?apikey=... query auth. v3.0.0 supports Bearer.
//
// Env vars:
//   ROIC_API_KEY  — the individual-plan key from roic.ai/account
//
// Public helpers:
//   roicGet(path, params)      → raw JSON, auto-adds apikey
//   roicRateLimiter(perMinute) → returns an async gate() function; call
//                                 await gate() before each request to
//                                 stay under the plan's rate limit.
// ═══════════════════════════════════════════════════════════════════

const BASE = 'https://api.roic.ai';

function key() {
  // ROIC_API_KEY normally holds the api key in Vercel production.
  // When running locally through the custom-cred HTTPS proxy, the proxy
  // rewrites the ?apikey param on every request to api.roic.ai, so any
  // non-empty placeholder here still results in a valid request.
  const k = process.env.ROIC_API_KEY || process.env.CUSTOM_CRED_API_ROIC_AI_TOKEN;
  if (!k) throw new Error('ROIC_API_KEY not configured');
  return k;
}

async function roicGet(path, params = {}) {
  const k = key();
  // Placeholder means we're behind the custom-cred proxy — DON'T include
  // apikey in the query, the proxy will inject the real one.
  const isPlaceholder = k === 'PROXY_INJECTED';
  const qpObj = { ...params };
  if (!isPlaceholder) qpObj.apikey = k;
  const qp = new URLSearchParams(qpObj);
  const url = `${BASE}${path.startsWith('/') ? path : '/' + path}?${qp.toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    const msg = typeof body === 'object'
      ? (body.error?.message || body.error || JSON.stringify(body))
      : String(body).slice(0, 300);
    const err = new Error(`ROIC ${path} ${r.status}: ${msg}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Simple token-bucket-ish rate limiter for a nightly batch job.
// Individual plan: 300 req/min. We use 250 to stay comfortably under.
function roicRateLimiter(perMinute = 250) {
  const minGapMs = Math.ceil(60_000 / perMinute); // ~240ms at 250/min
  let last = 0;
  return async function gate() {
    const now = Date.now();
    const wait = last + minGapMs - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
}

// ─────────────────────────────────────────────────────────
// Per-ticker snapshot fetcher
// Fetches profile + profitability + credit + multiples + EV + revenue
// history in 5 requests and returns a flat row for screener_snapshot.
// ─────────────────────────────────────────────────────────

async function fetchTickerSnapshot(ticker) {
  const t = ticker.toUpperCase();
  const [profile, prof, credit, mult, ev, income] = await Promise.all([
    roicGet(`/v2/company/profile/${t}`).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/ratios/profitability/${t}`, { period: 'annual', limit: 1 }).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/ratios/credit/${t}`, { period: 'annual', limit: 1 }).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/multiples/${t}`, { period: 'annual', limit: 1 }).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/enterprise-value/${t}`, { period: 'annual', limit: 1 }).catch(e => ({ __err: e.message })),
    roicGet(`/v2/fundamental/income-statement/${t}`, { period: 'annual', limit: 6 }).catch(e => ({ __err: e.message })),
  ]);

  const p = Array.isArray(profile) ? profile[0] : null;
  const pr = Array.isArray(prof) ? prof[0] : null;
  const cr = Array.isArray(credit) ? credit[0] : null;
  const mu = Array.isArray(mult) ? mult[0] : null;
  const evv = Array.isArray(ev) ? ev[0] : null;
  const inc = Array.isArray(income) ? income : [];

  if (!p && !pr && !mu && !evv) {
    // Nothing usable
    return null;
  }

  // Revenue CAGR 5y — from income statement history
  let revLtm = null, rev5 = null, cagr5 = null;
  if (inc.length >= 2) {
    const sorted = inc
      .filter(r => r.is_sales_revenue_turnover != null)
      .sort((a, b) => (b.period_label || '').localeCompare(a.period_label || ''));
    if (sorted.length >= 2) {
      revLtm = Number(sorted[0].is_sales_revenue_turnover);
      const oldest = sorted[Math.min(sorted.length - 1, 5)];
      rev5 = Number(oldest.is_sales_revenue_turnover);
      const years = sorted.length - 1;
      if (revLtm > 0 && rev5 > 0 && years > 0) {
        cagr5 = (Math.pow(revLtm / rev5, 1 / years) - 1) * 100;
      }
    }
  }

  const row = {
    ticker: t,
    company_name: p?.company_name || null,
    sector: p?.sector || null,
    industry: p?.industry || null,
    exchange: p?.exchange_short_name || p?.exchange || null,
    currency: p?.currency || null,
    price: p?.price ?? null,
    market_cap: evv?.market_cap ?? null,
    enterprise_value: evv?.enterprise_value ?? null,
    roic: pr?.return_on_inv_capital ?? null,
    roe: pr?.return_com_eqy ?? null,
    roa: pr?.return_on_asset ?? null,
    gross_margin: pr?.gross_margin ?? null,
    operating_margin: pr?.oper_margin ?? null,
    ebitda_margin: pr?.ebitda_margin ?? null,
    profit_margin: pr?.profit_margin ?? null,
    debt_to_ebitda: cr?.tot_debt_to_ebitda ?? null,
    net_debt_to_ebitda: cr?.net_debt_to_ebitda ?? null,
    debt_to_equity: cr?.tot_debt_to_tot_eqy ?? null,
    pe_ratio: mu?.pe_ratio ?? null,
    ev_to_ebitda: evv?.ev_to_ttm_ebitda ?? null,
    ev_to_sales: evv?.ev_to_ttm_sales ?? null,
    price_to_book: mu?.pr_to_book_ratio ?? null,
    price_to_sales: mu?.pr_to_sales_ratio ?? null,
    revenue_ltm: revLtm,
    revenue_5y_ago: rev5,
    revenue_cagr_5y: cagr5,
    fiscal_year: pr?.fiscal_year || evv?.fiscal_year || null,
    as_of_date: pr?.date || evv?.date || null,
    refresh_status: 'ok',
  };

  return row;
}

// List all US listed stocks (NYSE / NASDAQ / AMEX, type=stock)
async function fetchUsTickers() {
  const all = await roicGet('/v2/tickers/list', { listed: 'true' });
  if (!Array.isArray(all)) throw new Error('tickers/list returned non-array');
  return all
    .filter(t => t?.type === 'stock' && ['NYSE', 'NASDAQ', 'AMEX'].includes(t.exchange))
    .map(t => t.symbol)
    .filter(Boolean);
}

module.exports = {
  roicGet,
  roicRateLimiter,
  fetchTickerSnapshot,
  fetchUsTickers,
};
