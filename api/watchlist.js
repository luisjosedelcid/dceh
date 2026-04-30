// GET /api/watchlist
//   Returns watchlist entries (active + triggered by default).
//   Enriches each entry with current_price (from prices_daily) and live MoS.
//
//   Query params:
//     ?status=active|triggered|archived|all   (default: active,triggered)
//     ?ticker=BKNG                            (optional filter)
//     ?limit=100                              (default 100)
//
// Auth: any active user can read.

'use strict';

const { sbSelect } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['any']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const status = url.searchParams.get('status') || 'active,triggered';
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);

    let q = `select=*&order=updated_at.desc&limit=${limit}`;
    if (status && status !== 'all') {
      const list = status.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 1) q += `&status=eq.${list[0]}`;
      else q += `&status=in.(${list.join(',')})`;
    }
    if (ticker) q += `&ticker=eq.${ticker}`;

    const entries = await sbSelect('watchlist', q);

    // Pull latest prices for the tickers in scope (one query, in.() filter).
    let prices = {};
    if (entries.length > 0) {
      const tickers = Array.from(new Set(entries.map(e => e.ticker)));
      const priceQ = `select=ticker,close_native,price_date&ticker=in.(${tickers.join(',')})&order=price_date.desc&limit=${tickers.length * 5}`;
      const rows = await sbSelect('prices_daily', priceQ);
      // Take the most recent per ticker
      for (const r of rows) {
        if (!prices[r.ticker]) prices[r.ticker] = r;
      }
    }

    const today = new Date();
    const items = entries.map(e => {
      const p = prices[e.ticker];
      const currentPrice = p ? Number(p.close_native) : null;
      const target = Number(e.target_price);
      const anchor = Number(e.anchor_value_per_share);
      const mosRequired = Number(e.mos_required_pct);
      const gapPct = currentPrice != null ? (currentPrice - target) / target : null;
      const mosCurrent = currentPrice != null ? (anchor - currentPrice) / anchor : null;
      const inBuyZone = currentPrice != null && currentPrice <= target && mosCurrent >= mosRequired;
      const daysToReview = e.deadline_review
        ? Math.floor((new Date(e.deadline_review) - today) / (1000 * 60 * 60 * 24))
        : null;
      return {
        ...e,
        current_price: currentPrice,
        current_price_date: p ? p.price_date : null,
        gap_pct: gapPct,
        mos_current_pct: mosCurrent,
        in_buy_zone: inBuyZone,
        days_to_review: daysToReview,
      };
    });

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, items }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
