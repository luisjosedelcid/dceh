// ═══════════════════════════════════════════════════════════════════
// GET /api/schwab-statement-status
// ───────────────────────────────────────────────────────────────────
// Reports whether the Schwab monthly statement for the previous month
// has already been imported.
//
// Rule: every month, starting on day 1, the previous month's statement
// should be imported. If today is 2026-08-03 and there is no
// import_schwab audit entry with ts >= 2026-08-01, we flag it.
//
// Returns:
//   { ok, needs_import, missing_month, months_behind, last_import }
//   - needs_import  : true if the current-month import hasn't happened
//   - missing_month : 'YYYY-MM' of the earliest month whose statement is
//                     still pending (usually last month)
//   - months_behind : how many statements are pending (>=1)
//   - last_import   : { ts, actor_email, filename } or null
//
// Auth: admin or analyst (read-only).
// ═══════════════════════════════════════════════════════════════════

const { requireRole } = require('./_require-role');
const { sbSelect } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = await requireRole(req, ['admin', 'analyst']);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    // Most recent Schwab import in the audit log.
    const rows = await sbSelect(
      'report_audit',
      `select=ts,actor_email,filename&action=eq.import_schwab&order=ts.desc&limit=1`
    );
    const last = Array.isArray(rows) && rows.length ? rows[0] : null;

    const now = new Date();
    const firstOfCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // If there is no import, we're missing at least the previous month.
    let needsImport = false;
    let monthsBehind = 0;
    let missingMonth = null;

    if (!last) {
      needsImport = true;
      monthsBehind = 1;
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      missingMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    } else {
      const lastTs = new Date(last.ts);
      if (lastTs < firstOfCurrentMonth) {
        needsImport = true;
        // Count how many month boundaries have crossed since the last import.
        // Anchor at the first-of-month for the last import.
        const anchor = new Date(Date.UTC(lastTs.getUTCFullYear(), lastTs.getUTCMonth(), 1));
        monthsBehind =
          (firstOfCurrentMonth.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
          (firstOfCurrentMonth.getUTCMonth() - anchor.getUTCMonth());
        // The earliest pending statement is the month AFTER the last import.
        const missing = new Date(Date.UTC(lastTs.getUTCFullYear(), lastTs.getUTCMonth(), 1));
        missingMonth = `${missing.getUTCFullYear()}-${String(missing.getUTCMonth() + 1).padStart(2, '0')}`;
      }
    }

    res.status(200).json({
      ok: true,
      needs_import: needsImport,
      missing_month: missingMonth,
      months_behind: monthsBehind,
      last_import: last
        ? { ts: last.ts, actor_email: last.actor_email, filename: last.filename }
        : null,
    });
  } catch (e) {
    console.error('[schwab-statement-status]', e);
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
