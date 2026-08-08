// /api/admin/dr-status
// Devuelve el estado agregado del sistema DR:
//   - ultimo snapshot semanal (fecha, tamano, checksum, destino)
//   - ultimo fire drill (fecha, status, dias hasta el siguiente recomendado)
//   - historial reciente de ambos

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect } = require('../_supabase.js');

const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

module.exports = async (req, res) => {
  const claims = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!claims) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const snapshots = await sbSelect('dr_snapshot_log',
      'select=*&order=started_at.desc&limit=10');
    const drills = await sbSelect('dr_test_log',
      'select=*&order=started_at.desc&limit=10');

    // Compute derived signals
    const latestSuccessfulSnapshot = snapshots.find(s => s.status === 'success' || s.status === 'partial');
    const latestSuccessfulDrill = drills.find(d => d.status === 'success' || d.status === 'partial');

    let snapshotAgeDays = null;
    if (latestSuccessfulSnapshot) {
      snapshotAgeDays = Math.floor(
        (Date.now() - new Date(latestSuccessfulSnapshot.finished_at || latestSuccessfulSnapshot.started_at).getTime())
        / 86400000
      );
    }

    let drillAgeDays = null;
    let nextDrillRecommendedDays = null;
    if (latestSuccessfulDrill) {
      drillAgeDays = Math.floor(
        (Date.now() - new Date(latestSuccessfulDrill.finished_at || latestSuccessfulDrill.started_at).getTime())
        / 86400000
      );
      // Recommend quarterly (90 days)
      nextDrillRecommendedDays = 90 - drillAgeDays;
    }

    // Overall health signal
    let health = 'unknown';
    if (!latestSuccessfulSnapshot) health = 'no-snapshot';
    else if (snapshotAgeDays > 14) health = 'snapshot-stale';
    else if (!latestSuccessfulDrill) health = 'no-drill-yet';
    else if (drillAgeDays > 120) health = 'drill-overdue';
    else if (latestSuccessfulDrill.status === 'partial') health = 'drill-partial';
    else health = 'healthy';

    res.status(200).json({
      ok: true,
      health,
      latest_snapshot: latestSuccessfulSnapshot ? {
        id: latestSuccessfulSnapshot.id,
        started_at: latestSuccessfulSnapshot.started_at,
        finished_at: latestSuccessfulSnapshot.finished_at,
        status: latestSuccessfulSnapshot.status,
        kind: latestSuccessfulSnapshot.kind,
        destination: latestSuccessfulSnapshot.destination,
        bytes_total: latestSuccessfulSnapshot.bytes_total,
        tables_included: latestSuccessfulSnapshot.tables_included,
        files_included: latestSuccessfulSnapshot.files_included,
        checksum: latestSuccessfulSnapshot.checksum,
        age_days: snapshotAgeDays,
      } : null,
      latest_drill: latestSuccessfulDrill ? {
        id: latestSuccessfulDrill.id,
        started_at: latestSuccessfulDrill.started_at,
        finished_at: latestSuccessfulDrill.finished_at,
        status: latestSuccessfulDrill.status,
        source_backup_date: latestSuccessfulDrill.source_backup_date,
        tables_verified: latestSuccessfulDrill.tables_verified,
        files_verified: latestSuccessfulDrill.files_verified,
        age_days: drillAgeDays,
        next_recommended_in_days: nextDrillRecommendedDays,
      } : null,
      snapshots_history: snapshots.map(s => ({
        id: s.id,
        started_at: s.started_at,
        status: s.status,
        kind: s.kind,
        destination: s.destination,
        bytes_total: s.bytes_total,
        tables_included: s.tables_included,
        files_included: s.files_included,
      })),
      drills_history: drills.map(d => ({
        id: d.id,
        started_at: d.started_at,
        status: d.status,
        kind: d.kind,
        tables_verified: d.tables_verified,
        files_verified: d.files_verified,
        error: d.error,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch DR status', detail: e.message });
  }
};
