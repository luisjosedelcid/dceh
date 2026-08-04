// ═══════════════════════════════════════════════════════════════════
// DCE Holdings — Real Estate historical marks (as-of resolver)
// ═══════════════════════════════════════════════════════════════════
// The Real Estate sleeve is marked by the GP (AX Partners) semi-annually.
// This helper resolves, for a given as-of date, the NAV/MOIC/commentary of
// each position based on the most recent GP mark whose mark_date <= as_of.
//
// Fallback: if the as-of is before ANY published mark for a given position
// (e.g. between deployment and the first S-report), we hold NAV at par
// (= capital contributed in EUR, MOIC = 1.00). This matches the initial
// accounting policy for a fresh private RE commitment.
//
// The static JSON at /public/real_estate_positions.json continues to hold
// the *position master* (immutable fields: name, vehicle, subscription
// date, amount_eur, deploy FX, ownership pct, target ranges, etc.). Only
// the mark itself (nav_eur, moic_eur_reported, gp_commentary, nav_as_of,
// source) is resolved dynamically from Supabase.

const { sbSelect } = require('./_supabase');

/**
 * Load all marks up to and including `asOfYMD` and pick the most recent per
 * position. Returns a Map keyed by position_id → { mark_date, nav_eur,
 * moic_eur, source, gp_commentary, report_period }.
 */
async function loadMarksAsOf(asOfYMD) {
  const query =
    `select=position_id,mark_date,reported_at,nav_eur,moic_eur,report_period,source,gp_commentary` +
    `&mark_date=lte.${encodeURIComponent(asOfYMD)}` +
    `&order=position_id.asc,mark_date.desc`;
  const rows = await sbSelect('real_estate_marks', query);
  const latest = new Map();
  for (const r of rows || []) {
    if (!latest.has(r.position_id)) {
      latest.set(r.position_id, {
        mark_date:      r.mark_date,
        reported_at:    r.reported_at,
        nav_eur:        Number(r.nav_eur),
        moic_eur:       r.moic_eur != null ? Number(r.moic_eur) : null,
        report_period:  r.report_period,
        source:         r.source,
        gp_commentary:  r.gp_commentary,
      });
    }
  }
  return latest;
}

/**
 * Given the static position master and an as-of date, returns an enriched
 * position with the mark that applies at that date. If no prior mark exists,
 * returns the deployment-par fallback with source flag.
 */
function applyMarkOrFallback(pos, mark, asOfYMD) {
  if (mark) {
    return {
      ...pos,
      nav_eur:               mark.nav_eur,
      moic_eur_reported:     mark.moic_eur != null ? mark.moic_eur : (mark.nav_eur / Number(pos.amount_eur)),
      _mark_date:            mark.mark_date,
      _mark_period:          mark.report_period,
      _mark_source:          mark.source,
      gp_commentary_s1_2026: mark.gp_commentary || pos.gp_commentary_s1_2026 || null,
      _mark_status:          'gp',
    };
  }
  // Deployment-par fallback: before the first GP mark, NAV = capital in EUR.
  const deployYMD = pos.deployment_date || pos.subscription_date;
  const deployed = !deployYMD || deployYMD <= asOfYMD;
  return {
    ...pos,
    nav_eur:            Number(pos.amount_eur) || 0,
    moic_eur_reported:  1.00,
    _mark_date:         deployed ? deployYMD : asOfYMD,
    _mark_period:       'PAR',
    _mark_source:       deployed
      ? 'At par (no GP mark published prior to as-of)'
      : 'Not yet deployed as of requested date',
    _mark_status:       deployed ? 'par' : 'pre_deploy',
  };
}

/**
 * Full resolver: takes the static JSON + as-of date and returns an object
 * mirroring the shape of the JSON but with dynamic marks applied.
 *
 * Effective nav_as_of = the LATEST mark_date across positions (if any).
 * If no marks exist yet, effective_nav_as_of = as_of itself (par fallback).
 */
async function resolveRealEstateAsOf(staticJson, asOfYMD) {
  const positions = Array.isArray(staticJson.positions) ? staticJson.positions : [];
  const marks = await loadMarksAsOf(asOfYMD);
  const enriched = positions.map(p => applyMarkOrFallback(p, marks.get(p.id), asOfYMD));
  const anyGpMark = enriched.filter(e => e._mark_status === 'gp');
  const latestMarkDate = anyGpMark.length
    ? anyGpMark.reduce((max, e) => (e._mark_date > max ? e._mark_date : max), anyGpMark[0]._mark_date)
    : asOfYMD;
  const latestSource = anyGpMark.length
    ? [...new Set(anyGpMark.map(e => e._mark_source).filter(Boolean))].join(' · ')
    : 'At par (no GP mark published as of requested date)';
  return {
    ...staticJson,
    nav_as_of:         latestMarkDate,
    source:            latestSource,
    positions:         enriched,
    _asof_requested:   asOfYMD,
    _asof_effective:   latestMarkDate,
    _using_par_fallback: anyGpMark.length === 0,
  };
}

module.exports = {
  loadMarksAsOf,
  applyMarkOrFallback,
  resolveRealEstateAsOf,
};
