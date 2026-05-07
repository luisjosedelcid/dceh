// Archive / reactivate pre-mortems linked to a ticker.
// Extracted from api/admin/journal.js so the new journal-create / journal-delete
// endpoints can reuse the same logic without duplication.
//
// Idempotent. Returns IDs of affected rows for visibility/logging.

const { sbSelect, sbUpdate } = require('./_supabase');

// Archive every active pre-mortem for a ticker (used on SELL).
// Also invalidates any monitoring/triggered failure_modes hanging off them.
async function archivePremortemForTicker(ticker) {
  const t = encodeURIComponent(String(ticker || '').toUpperCase().trim());
  if (!t) return { archived_premortem_ids: [], invalidated_failure_mode_ids: [] };

  const pms = await sbSelect('premortems', `select=id&ticker=eq.${t}&status=eq.active&limit=10`);
  if (!pms.length) return { archived_premortem_ids: [], invalidated_failure_mode_ids: [] };

  const pmIds = pms.map((p) => p.id);
  const ts = new Date().toISOString();

  await sbUpdate('premortems', `id=in.(${pmIds.join(',')})`, {
    status: 'archived',
    updated_at: ts,
  });

  const fms = await sbSelect(
    'failure_modes',
    `select=id&premortem_id=in.(${pmIds.join(',')})&status=in.(monitoring,triggered)&limit=200`
  );
  const fmIds = fms.map((f) => f.id);
  if (fmIds.length) {
    await sbUpdate('failure_modes', `id=in.(${fmIds.join(',')})`, {
      status: 'invalidated',
      updated_at: ts,
    });
  }
  return { archived_premortem_ids: pmIds, invalidated_failure_mode_ids: fmIds };
}

// Reactivate the most recently archived pre-mortem for a ticker (used when an
// active SELL is undone). Re-opens the premortem row and the failure modes that
// were invalidated as part of the SELL flow.
async function reactivatePremortemForTicker(ticker) {
  const t = encodeURIComponent(String(ticker || '').toUpperCase().trim());
  if (!t) return { reactivated_premortem_ids: [], reactivated_failure_mode_ids: [] };

  const pms = await sbSelect(
    'premortems',
    `select=id&ticker=eq.${t}&status=eq.archived&order=updated_at.desc&limit=1`
  );
  if (!pms.length) return { reactivated_premortem_ids: [], reactivated_failure_mode_ids: [] };

  const pmId = pms[0].id;
  const ts = new Date().toISOString();

  await sbUpdate('premortems', `id=eq.${pmId}`, { status: 'active', updated_at: ts });

  const fms = await sbSelect(
    'failure_modes',
    `select=id&premortem_id=eq.${pmId}&status=eq.invalidated&limit=200`
  );
  const fmIds = fms.map((f) => f.id);
  if (fmIds.length) {
    await sbUpdate('failure_modes', `id=in.(${fmIds.join(',')})`, {
      status: 'monitoring',
      updated_at: ts,
    });
  }
  return { reactivated_premortem_ids: [pmId], reactivated_failure_mode_ids: fmIds };
}

module.exports = {
  archivePremortemForTicker,
  reactivatePremortemForTicker,
};
