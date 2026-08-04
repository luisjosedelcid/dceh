// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — FX rate helper
//
// Provides live EUR/USD (and generic base->USD) with 60-minute in-memory
// cache. Uses Frankfurter (ECB reference rates) as primary source and
// open.er-api.com as fallback. Vercel warm instances share the cache.
//
// Frankfurter publishes ECB reference rates once per business day around
// 16:00 CET, so intraday queries return the last-published rate.
// open.er-api.com publishes daily spot; used only if Frankfurter fails.
//
// If both fail, callers pass a `fallback` object (typically the FX quote
// already stored in real_estate_positions.json) and we return that so the
// PDF never crashes on network hiccups.
// ═══════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const _fxCache = new Map(); // key: `${base}-${quote}` -> { value, date, source, ts }
const _fxHistCache = new Map(); // key: `${date}-${base}-${quote}` -> { value, date, source }

async function _fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Some upstreams (Frankfurter's Cloudflare front, open.er-api) return 403
    // to node fetch without an explicit User-Agent. Supply one so historical
    // FX calls succeed from Vercel serverless.
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'DCE-Holdings-Investment-Office/1.0 (+https://www.dceholdings.app)',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function _tryFrankfurter(base, quote) {
  // Frankfurter: https://frankfurter.dev
  // Returns { amount, base, date, rates: { USD: 1.xxxx } }
  // `date` is the ECB publication date (business-day granularity).
  const j = await _fetchWithTimeout(
    `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`,
    4000
  );
  const rate = j && j.rates && Number(j.rates[quote]);
  if (!rate || !isFinite(rate) || rate <= 0) throw new Error('bad Frankfurter payload');
  return {
    value: rate,
    date: j.date || null,          // e.g. "2026-08-03"
    source: 'ECB (via Frankfurter)',
  };
}

async function _tryOpenErApi(base, quote) {
  // open.er-api.com: https://open.er-api.com/v6/latest/EUR
  // Returns { rates: {...}, time_last_update_utc: "Tue, 04 Aug 2026 00:02:31 +0000" }
  const j = await _fetchWithTimeout(
    `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    4000
  );
  const rate = j && j.rates && Number(j.rates[quote]);
  if (!rate || !isFinite(rate) || rate <= 0) throw new Error('bad open.er-api payload');
  // Convert RFC-2822 timestamp to YYYY-MM-DD.
  let date = null;
  if (j.time_last_update_utc) {
    try { date = new Date(j.time_last_update_utc).toISOString().slice(0, 10); } catch (_) { /* ignore */ }
  }
  return {
    value: rate,
    date,
    source: 'open.er-api.com (daily spot)',
  };
}

// Public: returns { value, date, source, cached, stale }.
// - value:   numeric rate quote per unit base
// - date:    ISO date the rate was published (YYYY-MM-DD)
// - source:  short human-readable label
// - cached:  true if returned from in-memory cache
// - stale:   true if both live sources failed and we returned the fallback
async function getFxRate(base, quote, opts = {}) {
  const key = `${String(base).toUpperCase()}-${String(quote).toUpperCase()}`;
  const now = Date.now();
  const cached = _fxCache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return { value: cached.value, date: cached.date, source: cached.source, cached: true, stale: false };
  }
  // Try primary, then fallback.
  const attempts = [_tryFrankfurter, _tryOpenErApi];
  let lastErr = null;
  for (const fn of attempts) {
    try {
      const r = await fn(base, quote);
      _fxCache.set(key, { value: r.value, date: r.date, source: r.source, ts: now });
      return { value: r.value, date: r.date, source: r.source, cached: false, stale: false };
    } catch (e) {
      lastErr = e;
    }
  }
  // Both failed. Use caller-supplied fallback if present.
  if (opts.fallback && Number(opts.fallback.value) > 0) {
    return {
      value: Number(opts.fallback.value),
      date: opts.fallback.date || null,
      source: (opts.fallback.source || 'fallback (cached in file)') + ' — live FX unavailable',
      cached: false,
      stale: true,
      error: lastErr ? String(lastErr.message || lastErr) : null,
    };
  }
  throw lastErr || new Error('FX unavailable and no fallback provided');
}

// Historical FX (published rate on or before a given ISO date).
// Uses Frankfurter, which supports /v1/{YYYY-MM-DD}?base=...&symbols=...
// If the requested date has no ECB publication (weekend/holiday), Frankfurter
// returns the previous business day automatically.
async function getFxRateOnDate(dateYMD, base, quote, opts = {}) {
  const key = `${dateYMD}-${String(base).toUpperCase()}-${String(quote).toUpperCase()}`;
  const hit = _fxHistCache.get(key);
  if (hit) return { ...hit, cached: true, stale: false };
  try {
    const j = await _fetchWithTimeout(
      `https://api.frankfurter.dev/v1/${encodeURIComponent(dateYMD)}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`,
      4000
    );
    const rate = j && j.rates && Number(j.rates[quote]);
    if (!rate || !isFinite(rate) || rate <= 0) throw new Error('bad Frankfurter historical payload');
    const r = { value: rate, date: j.date || dateYMD, source: 'ECB (via Frankfurter, historical)' };
    _fxHistCache.set(key, r);
    return { ...r, cached: false, stale: false };
  } catch (e) {
    // Only accept a fallback whose date is on or after the requested date.
    // A cached fallback dated BEFORE dateYMD would silently pull a stale rate
    // into a historical snapshot (this is exactly what produced the wrong
    // 1.1649 dated 2026-06-02 in the 2026-07-31 Real Estate PDF).
    const fb = opts.fallback;
    const fbDate = fb && fb.date;
    const fbUsable = fb && Number(fb.value) > 0 && (!fbDate || fbDate >= dateYMD);
    if (fbUsable) {
      return {
        value: Number(fb.value),
        date: fb.date || null,
        source: (fb.source || 'fallback (cached in file)') + ' \u2014 live FX unavailable',
        cached: false,
        stale: true,
        error: String(e.message || e),
      };
    }
    // Fallback rejected (or missing): surface the error so the caller can
    // block the report or show a clear "FX unavailable" state instead of
    // producing wrong numbers.
    const rejectionNote = (fb && fbDate && fbDate < dateYMD)
      ? ` (rejected cached fallback dated ${fbDate}, older than requested ${dateYMD})`
      : '';
    throw new Error(`FX historical unavailable for ${dateYMD}: ${e.message || e}${rejectionNote}`);
  }
}

module.exports = { getFxRate, getFxRateOnDate };
