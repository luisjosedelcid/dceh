// GET /api/cockpit
//   Process-center aggregator for the new Cockpit v2.
//   Returns: pipeline_in_flight, outstanding_decisions, reunderwriting_due,
//            earnings_upcoming, last_deliverables, watchlist_alerts, calendar_week,
//            status (KPIs counts), and meta.
//
//   NOTE: Open Tasks card is NOT served here — it's wired client-side via the
//   Notion connector (or shown as "connect Notion" placeholder). This endpoint
//   is purely Supabase-backed.
//
// Auth: open read (matches /api/earnings, /api/cockpit-summary patterns).

'use strict';

const { sbSelect } = require('./_supabase');

// ── helpers ───────────────────────────────────────────────────────────
function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── 1. Pipeline in flight ─────────────────────────────────────────────
async function getPipeline() {
  // Active stages only — exclude terminal (invested, passed, closed, rejected)
  const ACTIVE_STAGES = ['idea', 'research', 'committee', 'decision', 'execution', 'approved'];
  const stagesFilter = `(${ACTIVE_STAGES.map(s => `"${s}"`).join(',')})`;
  let rows = [];
  try {
    rows = await sbSelect(
      'pipeline_cards',
      `select=id,ticker,name,stage,quality,valuation,irr,note,moved_at,created_at,updated_at&stage=in.${stagesFilter}&order=moved_at.desc.nullslast&limit=50`
    );
  } catch (e) {
    console.error('getPipeline failed:', e.message);
    return [];
  }
  return rows.map(r => ({
    id: r.id,
    ticker: r.ticker,
    name: r.name || r.ticker,
    stage: r.stage,
    quality: r.quality,
    valuation: r.valuation,
    irr: r.irr,
    note: r.note,
    days_in_stage: daysSince(r.moved_at || r.updated_at || r.created_at),
    moved_at: r.moved_at || r.created_at,
  }));
}

// ── 2. Outstanding decisions ──────────────────────────────────────────
//   Decisions in journal whose committee review has not been finalized:
//   final_recommendation IS NULL or active=true with pending review_*_outcome
async function getOutstandingDecisions() {
  let rows = [];
  try {
    rows = await sbSelect(
      'decision_journal',
      `select=id,ticker,decision_type,decision_date,thesis,final_recommendation,active,decision_owner,reviewer,review_3m_date,review_3m_outcome,review_6m_date,review_6m_outcome,review_12m_date,review_12m_outcome&order=decision_date.desc.nullslast&limit=200`
    );
  } catch (e) {
    console.error('getOutstandingDecisions failed:', e.message);
    return [];
  }
  const today = todayISO();
  const out = [];
  for (const r of rows) {
    // (a) decisions with no final_recommendation yet
    if (!r.final_recommendation) {
      out.push({
        id: r.id,
        ticker: r.ticker,
        kind: 'pending_ratification',
        decision_type: r.decision_type,
        decision_date: r.decision_date,
        days_open: daysSince(r.decision_date),
        owner: r.decision_owner,
        thesis: r.thesis ? String(r.thesis).slice(0, 120) : null,
      });
      continue;
    }
    // (b) active decisions with overdue scheduled reviews
    if (r.active) {
      for (const period of ['3m', '6m', '12m']) {
        const dateField = r[`review_${period}_date`];
        const outcomeField = r[`review_${period}_outcome`];
        if (dateField && !outcomeField && dateField <= today) {
          out.push({
            id: `${r.id}_${period}`,
            ticker: r.ticker,
            kind: `review_${period}_overdue`,
            decision_type: r.decision_type,
            decision_date: r.decision_date,
            review_due: dateField,
            days_overdue: -daysUntil(dateField),
            owner: r.reviewer || r.decision_owner,
          });
          break; // one row per ticker
        }
      }
    }
  }
  return out.slice(0, 25);
}

// ── 3. Re-underwriting due ────────────────────────────────────────────
//   Only truly open work: status IN (pending, in_progress).
//   Excludes: completed / done / skipped / superseded — those are not actionable.
async function getReunderwritingDue() {
  let rows = [];
  try {
    rows = await sbSelect(
      'reunderwriting_due',
      `select=id,ticker,period_end,doc_type,status,due_at,completed_at,outcome&status=in.(pending,in_progress)&order=due_at.asc.nullslast&limit=30`
    );
  } catch (e) {
    console.error('getReunderwritingDue failed:', e.message);
    return [];
  }
  return rows.map(r => ({
    id: r.id,
    ticker: r.ticker,
    period_end: r.period_end,
    doc_type: r.doc_type,
    status: r.status,
    due_at: r.due_at,
    days_until_due: r.due_at ? daysUntil(r.due_at) : null,
  }));
}

// ── 4. Earnings upcoming ──────────────────────────────────────────────
async function getEarningsUpcoming() {
  const today = todayISO();
  const horizon = plusDaysISO(45);
  let rows = [];
  try {
    rows = await sbSelect(
      'earnings_calendar',
      `select=ticker,company,date,timing,hour,eps_estimate,revenue_estimate,status&status=eq.upcoming&date=gte.${today}&date=lte.${horizon}&order=date.asc&limit=30`
    );
  } catch (e) {
    console.error('getEarningsUpcoming failed:', e.message);
    return [];
  }
  return rows.map(r => ({
    ticker: r.ticker,
    company: r.company || r.ticker,
    date: r.date,
    timing: r.timing,
    hour: r.hour,
    days_until: daysUntil(r.date),
    eps_estimate: r.eps_estimate,
    revenue_estimate: r.revenue_estimate,
  }));
}

// ── 5. Last deliverables (data room) ──────────────────────────────────
async function getLastDeliverables() {
  let rows = [];
  try {
    rows = await sbSelect(
      'dataroom_files',
      `select=id,name,filename,url,storage_path,size_bytes,mime_type,detail,uploaded_at,uploaded_by&order=uploaded_at.desc.nullslast&limit=8`
    );
  } catch (e) {
    console.error('getLastDeliverables failed:', e.message);
    return [];
  }
  return rows.map(r => {
    const fname = r.filename || r.name || '';
    const ext = (fname.split('.').pop() || '').toLowerCase();
    let kind = 'doc';
    if (['pdf'].includes(ext)) kind = 'pdf';
    else if (['xls', 'xlsx', 'csv'].includes(ext)) kind = 'xls';
    else if (['doc', 'docx'].includes(ext)) kind = 'doc';
    else if (['png', 'jpg', 'jpeg', 'svg'].includes(ext)) kind = 'img';
    return {
      id: r.id,
      name: r.name || r.filename,
      filename: r.filename,
      url: r.url,
      kind,
      uploaded_at: r.uploaded_at,
      days_ago: daysSince(r.uploaded_at),
      uploaded_by: r.uploaded_by,
    };
  });
}

// ── 6. Watchlist alerts ───────────────────────────────────────────────
async function getWatchlistAlerts() {
  let rows = [];
  try {
    rows = await sbSelect(
      'watchlist',
      `select=id,ticker,target_price,anchor_type,mos_required_pct,catalyst,deadline_review,status,triggered_at,triggered_price,triggered_mos_pct&order=triggered_at.desc.nullslast&limit=200`
    );
  } catch (e) {
    console.error('getWatchlistAlerts failed:', e.message);
    return [];
  }
  const today = todayISO();
  const out = [];
  for (const r of rows) {
    const isTriggered = r.status === 'triggered';
    const reviewSoon = r.deadline_review && r.deadline_review >= today
                      && daysUntil(r.deadline_review) <= 14;
    const reviewOverdue = r.deadline_review && r.deadline_review < today
                         && r.status !== 'closed';
    if (isTriggered || reviewSoon || reviewOverdue) {
      out.push({
        id: r.id,
        ticker: r.ticker,
        kind: isTriggered ? 'triggered' : (reviewOverdue ? 'review_overdue' : 'review_soon'),
        target_price: r.target_price,
        anchor_type: r.anchor_type,
        mos_required_pct: r.mos_required_pct,
        catalyst: r.catalyst,
        deadline_review: r.deadline_review,
        triggered_at: r.triggered_at,
        triggered_price: r.triggered_price,
        triggered_mos_pct: r.triggered_mos_pct,
        days_until_review: r.deadline_review ? daysUntil(r.deadline_review) : null,
      });
    }
  }
  return out.slice(0, 12);
}

// ── 7. Calendar this week (earnings + future: gcal events) ────────────
async function getCalendarWeek() {
  const today = todayISO();
  const weekEnd = plusDaysISO(7);
  let rows = [];
  try {
    rows = await sbSelect(
      'earnings_calendar',
      `select=ticker,company,date,timing,hour,status&date=gte.${today}&date=lte.${weekEnd}&order=date.asc&limit=20`
    );
  } catch (e) {
    console.error('getCalendarWeek failed:', e.message);
    return [];
  }
  return rows.map(r => ({
    ticker: r.ticker,
    company: r.company || r.ticker,
    date: r.date,
    timing: r.timing,
    hour: r.hour,
    days_until: daysUntil(r.date),
    type: 'earnings',
    status: r.status,
  }));
}

// ── handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  try {
    const [
      pipeline,
      decisions,
      reunderwriting,
      earnings,
      deliverables,
      watchlist,
      calendarWeek,
    ] = await Promise.all([
      getPipeline(),
      getOutstandingDecisions(),
      getReunderwritingDue(),
      getEarningsUpcoming(),
      getLastDeliverables(),
      getWatchlistAlerts(),
      getCalendarWeek(),
    ]);

    // KPIs for status bar
    const earningsThisWeek = earnings.filter(e => e.days_until !== null && e.days_until <= 7).length;
    const status = {
      open_processes: pipeline.length,
      decisions_pending: decisions.length,
      reunderwriting_due: reunderwriting.length,
      earnings_this_week: earningsThisWeek,
      watchlist_alerts: watchlist.length,
      last_sync: new Date().toISOString(),
    };

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      status,
      sections: {
        pipeline_in_flight: pipeline,
        outstanding_decisions: decisions,
        reunderwriting_due: reunderwriting,
        earnings_upcoming: earnings,
        last_deliverables: deliverables,
        watchlist_alerts: watchlist,
        calendar_week: calendarWeek,
      },
      meta: {
        generated_at: new Date().toISOString(),
        notion_tasks_note: 'Open Tasks card is wired client-side; not included here.',
      },
    }));
  } catch (e) {
    console.error('GET /api/cockpit failed:', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal_error', detail: e.message }));
  }
};
