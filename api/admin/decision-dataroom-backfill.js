// ═══════════════════════════════════════════════════════════════════
// POST /api/admin/decision-dataroom-backfill
// ───────────────────────────────────────────────────────────────────
// Archives all active decision_journal rows to Data Room ▸ Decision
// Journal ▸ <subfolder> using the same mirror as journal-create.
//
// Idempotency: checks dataroom_files by filename prefix
// (Decision_<TICKER>_<TYPE>_<YYYYMMDD>) in the target subfolder and
// skips entries that already have a file with that prefix.
//
// Body: (none) — optional { dry_run: true } returns what would be done.
// Auth: x-admin-token (admin role).
// ═══════════════════════════════════════════════════════════════════

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect } = require('../_supabase');
const {
  mirrorDecisionToDataroom,
  subfolderForDecision,
  loadDecisionJournalFolders,
} = require('../_decision-dataroom-mirror');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
    if (!ADMIN_TOKEN_SECRET) {
      res.status(500).json({ error: 'Server not configured' });
      return;
    }
    const token = String(req.headers['x-admin-token'] || '').trim();
    if (!token) { res.status(401).json({ error: 'Missing token' }); return; }
    const verified = verifyAdminToken(token, ADMIN_TOKEN_SECRET);
    if (!verified || !verified.email) {
      res.status(401).json({ error: 'Invalid token' }); return;
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const dryRun = !!(body && body.dry_run);

    const decisions = await sbSelect(
      'decision_journal',
      `select=id,ticker,decision_type,decision_date&active=eq.true&order=id.asc`
    );

    const folders = await loadDecisionJournalFolders();
    const results = [];

    for (const d of decisions) {
      const sub = subfolderForDecision(d.decision_type);
      if (!sub) {
        results.push({ id: d.id, ticker: d.ticker, decision_type: d.decision_type, skipped: 'unsupported_type' });
        continue;
      }
      const folderId = folders.bySubName[sub];
      if (!folderId) {
        results.push({ id: d.id, ticker: d.ticker, decision_type: d.decision_type, skipped: `folder_not_found:${sub}` });
        continue;
      }
      const dateCompact = String(d.decision_date || '').replace(/-/g, '');
      const filenamePrefix = `Decision_${d.ticker}_${String(d.decision_type).toUpperCase()}_${dateCompact}`;

      // Idempotency: has any file in this subfolder that starts with the expected prefix?
      const existing = await sbSelect(
        'dataroom_files',
        `select=id,filename&folder_id=eq.${folderId}&filename=ilike.${encodeURIComponent(filenamePrefix + '%')}&limit=1`
      );
      if (Array.isArray(existing) && existing.length > 0) {
        results.push({ id: d.id, ticker: d.ticker, decision_type: d.decision_type, subfolder: sub, skipped: 'already_archived', file_id: existing[0].id });
        continue;
      }

      if (dryRun) {
        results.push({ id: d.id, ticker: d.ticker, decision_type: d.decision_type, subfolder: sub, would_archive: true });
        continue;
      }

      const r = await mirrorDecisionToDataroom({
        entryId: d.id,
        adminToken: token,
        actor: verified.email,
        decisionType: d.decision_type,
        ticker: d.ticker,
        decisionDate: d.decision_date,
      });
      results.push({
        id: d.id,
        ticker: d.ticker,
        decision_type: d.decision_type,
        subfolder: sub,
        ok: r.ok,
        error: r.error || null,
        file_id: r.file ? r.file.id : null,
      });
    }

    res.status(200).json({ ok: true, dry_run: dryRun, count: results.length, results });
  } catch (e) {
    console.error('[decision-dataroom-backfill]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
