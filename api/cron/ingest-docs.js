// Cron — daily SEC EDGAR ingestion for all active premortems.
// Runs at 22:45 UTC (between portfolio-snapshot and premortem-eval).
// Authenticated via CRON_SECRET.

'use strict';

const { ingestAllActive } = require('../_doc-ingest');
const { sbSelect } = require('../_supabase');
const { sendReunderwritingDueAlert } = require('../_notify');

module.exports = async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.status(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const startedAt = new Date();
    const result = await ingestAllActive({ limitPerForm: 2 });

    // Summary stats
    let totalIngested = 0, totalSkipped = 0, totalErrors = 0;
    for (const r of (result.results || [])) {
      if (!r.ok) { totalErrors++; continue; }
      totalIngested += (r.ingested || []).length;
      totalSkipped += (r.skipped || []).length;
      totalErrors += (r.errors || []).length;
    }

    // Look up new pending re-underwriting dues created during this cron run.
    // We use created_at >= startedAt - 60s (small buffer for clock skew).
    let emailNotice = { skipped: true };
    try {
      const since = new Date(startedAt.getTime() - 60_000).toISOString();
      const newDues = await sbSelect(
        'reunderwriting_due',
        `select=id,ticker,period_end,doc_type,status&status=eq.pending&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=50`
      );
      if (newDues && newDues.length > 0) {
        emailNotice = await sendReunderwritingDueAlert({ items: newDues });
        emailNotice.dues = newDues.length;
      } else {
        emailNotice = { skipped: true, reason: 'no new dues' };
      }
    } catch (eDue) {
      emailNotice = { ok: false, error: String(eDue.message || eDue).slice(0, 200) };
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      tickers: result.tickers,
      totals: { ingested: totalIngested, skipped: totalSkipped, errors: totalErrors },
      reunderwriting_email: emailNotice,
      details: result.results,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
