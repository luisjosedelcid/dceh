// POST /api/admin-discipline-rules
//   Body: { rule_key: string, value: number }
//   Updates a single threshold. Admin only.
//
// Validation:
//   - rule_key must exist in discipline_rules
//   - value must be a finite number
//   - For 'pct' unit: 0 < value <= 1
//   - For 'days' unit: 0 < value <= 3650 (10 years)

'use strict';

const { sbSelect, sbUpdate } = require('./_supabase');
const { requireRole } = require('./_require-role');

module.exports = async (req, res) => {
  try {
    const auth = await requireRole(req, ['admin']);
    if (!auth.ok) {
      res.status(auth.status).end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const body = await readJsonBody(req);
    const ruleKey = String(body.rule_key || '').trim();
    const value = Number(body.value);

    if (!ruleKey) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'rule_key required' }));
      return;
    }
    if (!Number.isFinite(value)) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'value must be a finite number' }));
      return;
    }

    const existing = await sbSelect(
      'discipline_rules',
      `select=*&rule_key=eq.${encodeURIComponent(ruleKey)}&limit=1`
    );
    if (existing.length === 0) {
      res.status(404).end(JSON.stringify({ ok: false, error: `rule_key not found: ${ruleKey}` }));
      return;
    }
    const rule = existing[0];

    if (rule.unit === 'pct' && (value <= 0 || value > 1)) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'pct value must be between 0 and 1 (e.g. 0.10 = 10%)' }));
      return;
    }
    if (rule.unit === 'days' && (value <= 0 || value > 3650 || !Number.isInteger(value))) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'days value must be a positive integer up to 3650' }));
      return;
    }

    // Sanity check: concentration_warn_pct must be < concentration_fail_pct
    if (ruleKey === 'concentration_warn_pct' || ruleKey === 'concentration_fail_pct') {
      const warnRow = ruleKey === 'concentration_warn_pct'
        ? { value }
        : (await sbSelect('discipline_rules', 'select=value&rule_key=eq.concentration_warn_pct&limit=1'))[0];
      const failRow = ruleKey === 'concentration_fail_pct'
        ? { value }
        : (await sbSelect('discipline_rules', 'select=value&rule_key=eq.concentration_fail_pct&limit=1'))[0];
      if (warnRow && failRow && Number(warnRow.value) >= Number(failRow.value)) {
        res.status(400).end(JSON.stringify({ ok: false, error: 'concentration_warn_pct must be strictly less than concentration_fail_pct' }));
        return;
      }
    }

    const updated = await sbUpdate(
      'discipline_rules',
      `rule_key=eq.${encodeURIComponent(ruleKey)}`,
      {
        value,
        updated_at: new Date().toISOString(),
        updated_by: auth.user.email,
      }
    );

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({ ok: true, rule: Array.isArray(updated) ? updated[0] : updated }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
