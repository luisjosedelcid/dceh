// Cron — daily SEC EDGAR ingestion for all active premortems.
// Runs at 22:45 UTC (between portfolio-snapshot and premortem-eval).
// Authenticated via CRON_SECRET.

'use strict';

const { ingestAllActive } = require('../_doc-ingest');

module.exports = async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (auth !== expected) {
      res.status(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const result = await ingestAllActive({ limitPerForm: 2 });

    // Summary stats
    let totalIngested = 0, totalSkipped = 0, totalErrors = 0;
    for (const r of (result.results || [])) {
      if (!r.ok) { totalErrors++; continue; }
      totalIngested += (r.ingested || []).length;
      totalSkipped += (r.skipped || []).length;
      totalErrors += (r.errors || []).length;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      tickers: result.tickers,
      totals: { ingested: totalIngested, skipped: totalSkipped, errors: totalErrors },
      details: result.results,
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
