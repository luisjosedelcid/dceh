// GET /api/discipline-rules
//   Returns the current discipline thresholds from DB.
//   Auth: any authenticated user (read).

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

    const rules = await sbSelect('discipline_rules', 'select=*&order=rule_key.asc');

    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.status(200).end(JSON.stringify({ ok: true, rules }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
