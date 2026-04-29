// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Earnings Calendar Refresh cron
// GET /api/cron/earnings-refresh
//
// Pulls earnings events from Finnhub for a curated set of tickers (DCE
// universe + portfolio + watchlist) and upserts them into the
// earnings_calendar table.
//
// Window: today → today + 365 days (covers next four quarters).
//
// Triggered by Vercel cron (see vercel.json).
// Auth: x-cron-secret header OR x-vercel-cron header.
// ═══════════════════════════════════════════════════════════════════

const { sbSelect } = require('../_supabase.js');

// Tickers we always track. Universe (BKNG, SAP) hardcoded; portfolio +
// watchlist pulled live from positions / price_alerts so newly added
// tickers automatically start showing earnings.
const ALWAYS_TRACK = ['BKNG', 'SAP'];

// IR pages for known tickers (so the UI link is meaningful)
const IR_URLS = {
  BKNG: 'https://ir.bookingholdings.com',
  SAP:  'https://www.sap.com/investors/en/financial-documents-and-events/events.html',
  MSFT: 'https://www.microsoft.com/en-us/investor',
  AAPL: 'https://investor.apple.com',
  GOOGL:'https://abc.xyz/investor/',
};

const COMPANY_NAMES = {
  BKNG: 'Booking Holdings',
  SAP:  'SAP SE',
  MSFT: 'Microsoft',
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

async function getTrackedTickers() {
  const set = new Set(ALWAYS_TRACK);
  // Add any ticker from positions (portfolio) and price_alerts (watchlist)
  try {
    const pos = await sbSelect('positions', 'select=ticker&limit=200');
    pos.forEach(p => p && p.ticker && set.add(p.ticker.toUpperCase()));
  } catch {}
  try {
    const pa = await sbSelect('price_alerts', 'select=ticker&limit=500');
    pa.forEach(a => a && a.ticker && set.add(a.ticker.toUpperCase()));
  } catch {}
  return Array.from(set);
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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fhKey = process.env.FINNHUB_API_KEY || 'd6pi2h1r01qo88ajadq0d6pi2h1r01qo88ajadqg';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const fromIso = todayIso();
  const toIso = plusDaysIso(365);

  let tickers;
  try {
    tickers = await getTrackedTickers();
  } catch (e) {
    res.status(500).json({ error: 'Failed to load tickers', detail: String(e).slice(0, 200) });
    return;
  }

  const summary = { ok: true, from: fromIso, to: toIso, tickers, fetched: 0, upserted: 0, skipped: 0, errors: [] };

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
          company: COMPANY_NAMES[ticker] || ev.symbol || ticker,
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

  res.status(200).json(summary);
};
