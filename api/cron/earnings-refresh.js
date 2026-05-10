// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar Refresh cron
// GET /api/cron/earnings-refresh
//
// Pulls earnings events from Finnhub for a curated set of tickers (DCE
// covered universe + watchlist + portfolio + price alerts) and upserts
// them into the earnings_calendar table.
//
// Window: today → today + 365 days (covers next four quarters).
//
// Triggered by Vercel cron (see vercel.json), also re-used by
// /api/admin/earnings-refresh-now via runEarningsRefresh().
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('../_supabase.js');

// Hard fallback baseline so the calendar never empties out even if every
// other source is empty.
const ALWAYS_TRACK = ['BKNG', 'SAP'];

// IR pages for known tickers (so the UI link is meaningful). Any ticker
// not listed here will have ir_url=null in the calendar event — the
// admin can add it via the watchlist later.
const IR_URLS = {
  BKNG: 'https://ir.bookingholdings.com',
  SAP:  'https://www.sap.com/investors/en/financial-documents-and-events/events.html',
  MSFT: 'https://www.microsoft.com/en-us/investor',
  LULU: 'https://corporate.lululemon.com/investors',
  ORLY: 'https://corporate.oreillyauto.com/onlineapplications/investorrelations',
  ALSN: 'https://ir.allisontransmission.com',
  ALV:  'https://www.autoliv.com/investors',
  AAPL: 'https://investor.apple.com',
  GOOGL:'https://abc.xyz/investor/',
};

const COMPANY_NAMES = {
  BKNG: 'Booking Holdings',
  SAP:  'SAP SE',
  MSFT: 'Microsoft',
  LULU: 'Lululemon Athletica',
  ORLY: "O'Reilly Automotive",
  ALSN: 'Allison Transmission',
  ALV:  'Autoliv',
  AAPL: 'Apple',
  GOOGL:'Alphabet',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchEarningsForSymbol(symbol, fhKey, fromIso, toIso) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromIso}&to=${toIso}&symbol=${encodeURIComponent(symbol)}&token=${fhKey}`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`finnhub ${symbol}: ${r.status} ${text.slice(0, 160)}`);
  }
  const json = await r.json().catch(() => ({}));
  return Array.isArray(json && json.earningsCalendar) ? json.earningsCalendar : [];
}

function normalizeTiming(hour) {
  const h = (hour || '').toLowerCase();
  if (h === 'bmo') return 'BMO';
  if (h === 'amc') return 'AMC';
  if (h === 'dmh') return 'TBD';
  return 'TBD';
}

async function upsertEvent(supabaseUrl, serviceKey, row) {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/earnings_calendar?on_conflict=ticker,date`,
    {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`upsert ${row.ticker}/${row.date}: ${r.status} ${t.slice(0, 160)}`);
  }
}

// Pull tickers + display names from every relevant source so any company
// the team adds to the covered universe / watchlist starts producing
// earnings rows automatically on the next run.
async function getTrackedTickers() {
  const set = new Set(ALWAYS_TRACK);
  const names = {};

  // Covered universe = pipeline_cards (any stage)
  try {
    const cards = await sbSelect('pipeline_cards', 'select=ticker,name&limit=500');
    cards.forEach(c => {
      if (c && c.ticker) {
        const tk = c.ticker.toUpperCase();
        set.add(tk);
        if (c.name && !names[tk]) names[tk] = c.name;
      }
    });
  } catch {}

  // Active watchlist (price targets / catalysts)
  try {
    const wl = await sbSelect('watchlist', 'select=ticker&limit=500');
    wl.forEach(w => w && w.ticker && set.add(w.ticker.toUpperCase()));
  } catch {}

  // Portfolio (positions). Optional table — silently skip if missing.
  try {
    const pos = await sbSelect('positions', 'select=ticker&limit=500');
    pos.forEach(p => p && p.ticker && set.add(p.ticker.toUpperCase()));
  } catch {}

  // Price alerts
  try {
    const pa = await sbSelect('price_alerts', 'select=ticker&limit=500');
    pa.forEach(a => a && a.ticker && set.add(a.ticker.toUpperCase()));
  } catch {}

  return { tickers: Array.from(set), names };
}

// Tickers explicitly blocked by an admin (via Remove). The cron and
// admin refresh skip these even if they remain in pipeline_cards or
// watchlist. Returns a Set of uppercase tickers.
async function getBlocklist() {
  try {
    const rows = await sbSelect('calendar_blocklist', 'select=ticker&limit=500');
    return new Set(rows.map(r => String(r.ticker || '').toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Core refresh logic exposed for the manual admin trigger.
// `opts.onlyTickers` (array, optional) restricts the run to a subset.
async function runEarningsRefresh(opts) {
  opts = opts || {};
  const fhKey = process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fhKey) throw new Error('FINNHUB_KEY env var not set');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Supabase env vars not set');

  const fromIso = todayIso();
  const toIso = plusDaysIso(365);

  const [{ tickers: trackedAll, names: dbNames }, blocklist] = await Promise.all([
    getTrackedTickers(),
    getBlocklist(),
  ]);
  let tickers = trackedAll;
  if (Array.isArray(opts.onlyTickers) && opts.onlyTickers.length) {
    const filt = new Set(opts.onlyTickers.map(t => String(t || '').toUpperCase()));
    tickers = trackedAll.filter(t => filt.has(t));
    // Also include explicit tickers even if not yet in the tracked set
    opts.onlyTickers.forEach(t => {
      const tk = String(t || '').toUpperCase();
      if (tk && !tickers.includes(tk)) tickers.push(tk);
    });
  }

  // Honor blocklist unconditionally — even if the admin manually passed
  // the ticker. To re-enable, the admin must Unblock first.
  const blocked = [];
  tickers = tickers.filter(t => {
    if (blocklist.has(t)) { blocked.push(t); return false; }
    return true;
  });

  const summary = { ok: true, from: fromIso, to: toIso, tickers, blocked, fetched: 0, upserted: 0, skipped: 0, errors: [] };

  for (const ticker of tickers) {
    try {
      const events = await fetchEarningsForSymbol(ticker, fhKey, fromIso, toIso);
      summary.fetched += events.length;

      for (const ev of events) {
        const date = ev.date;
        if (!date) { summary.skipped++; continue; }
        const row = {
          ticker: ticker,
          date,
          company: COMPANY_NAMES[ticker] || dbNames[ticker] || ev.symbol || ticker,
          hour: ev.hour || null,
          timing: normalizeTiming(ev.hour),
          eps_estimate: Number.isFinite(ev.epsEstimate) ? ev.epsEstimate : null,
          eps_actual: Number.isFinite(ev.epsActual) ? ev.epsActual : null,
          revenue_estimate: Number.isFinite(ev.revenueEstimate) ? ev.revenueEstimate : null,
          revenue_actual: Number.isFinite(ev.revenueActual) ? ev.revenueActual : null,
          ir_url: IR_URLS[ticker] || null,
          status: ev.epsActual != null ? 'reported' : 'upcoming',
          source: 'finnhub',
          fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await upsertEvent(SUPABASE_URL, SUPABASE_SERVICE_KEY, row);
        summary.upserted++;
      }
      // Be gentle on Finnhub free-tier rate limit (60/min)
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      summary.errors.push({ ticker, error: String(e).slice(0, 200) });
    }
  }

  return summary;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['x-vercel-cron'] === 'true';
  const secretOk = req.headers['x-cron-secret'] === process.env.CRON_SECRET && !!process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const summary = await runEarningsRefresh({});
    res.status(200).json(summary);
  } catch (e) {
    res.status(500).json({ error: 'Refresh failed', detail: String(e).slice(0, 200) });
  }
};

// Exported helpers so the admin trigger and other server-side callers
// can re-use the exact same logic.
module.exports.runEarningsRefresh = runEarningsRefresh;
module.exports.getTrackedTickers = getTrackedTickers;
module.exports.getBlocklist = getBlocklist;
