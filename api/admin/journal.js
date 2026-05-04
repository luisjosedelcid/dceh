// DCE Holdings — Decision Journal admin API
// GET    /api/admin/journal             → list all (active + inactive)
// POST   /api/admin/journal             → create (JSON body)
// PATCH  /api/admin/journal?id=N        → update (JSON body)
// DELETE /api/admin/journal?id=N        → soft-delete (set active=false)
// POST   /api/admin/journal?review=3m|6m|12m&id=N
//        → mark a review done with body { outcome, lesson_learned? }
//
// Auth: x-admin-token header

const { verifyAdminToken } = require('../_admin-auth');
const { sbSelect, sbInsert, sbUpdate } = require('../_supabase');
const pipelineStage = require('../_pipeline-stage');

const VALID_TYPES = ['BUY', 'SELL', 'PASS', 'HOLD', 'TRIM', 'ADD'];
const VALID_OUTCOMES = ['played_out', 'partially', 'failed'];

// Archive pre-mortem + all its failure modes for a given ticker.
// Idempotent. Returns the IDs of affected rows for visibility.
async function archivePremortemForTicker(ticker) {
  const pms = await sbSelect('premortems', `select=id&ticker=eq.${encodeURIComponent(ticker)}&status=eq.active&limit=10`);
  if (!pms.length) return { archived_premortem_ids: [], invalidated_failure_mode_ids: [] };

  const pmIds = pms.map(p => p.id);
  const ts = new Date().toISOString();

  await sbUpdate('premortems', `id=in.(${pmIds.join(',')})`, {
    status: 'archived',
    updated_at: ts,
  });

  // Invalidate every monitoring/triggered failure mode under those premortems.
  const fms = await sbSelect('failure_modes', `select=id&premortem_id=in.(${pmIds.join(',')})&status=in.(monitoring,triggered)&limit=200`);
  const fmIds = fms.map(f => f.id);
  if (fmIds.length) {
    await sbUpdate('failure_modes', `id=in.(${fmIds.join(',')})`, {
      status: 'invalidated',
      updated_at: ts,
    });
  }
  return { archived_premortem_ids: pmIds, invalidated_failure_mode_ids: fmIds };
}

// Reactivate the most recently archived pre-mortem for a ticker (used when an
// active SELL is edited away or soft-deleted). Re-opens the premortem row and
// the failure modes that were invalidated as part of the SELL flow.
async function reactivatePremortemForTicker(ticker) {
  const pms = await sbSelect('premortems', `select=id&ticker=eq.${encodeURIComponent(ticker)}&status=eq.archived&order=updated_at.desc&limit=1`);
  if (!pms.length) return { reactivated_premortem_ids: [], reactivated_failure_mode_ids: [] };

  const pmId = pms[0].id;
  const ts = new Date().toISOString();

  await sbUpdate('premortems', `id=eq.${pmId}`, { status: 'active', updated_at: ts });

  const fms = await sbSelect('failure_modes', `select=id&premortem_id=eq.${pmId}&status=eq.invalidated&limit=200`);
  const fmIds = fms.map(f => f.id);
  if (fmIds.length) {
    await sbUpdate('failure_modes', `id=in.(${fmIds.join(',')})`, { status: 'monitoring', updated_at: ts });
  }
  return { reactivated_premortem_ids: [pmId], reactivated_failure_mode_ids: fmIds };
}

function addMonths(dateStr, months) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body || '{}');
}

module.exports = async (req, res) => {
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const auth = verifyAdminToken(req.headers['x-admin-token'], ADMIN_TOKEN_SECRET);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // ── Mark a review done ─────────────────────────
    if (req.method === 'POST' && req.query.review) {
      const id = parseInt(req.query.id || '', 10);
      const which = (req.query.review || '').toString();
      if (!Number.isFinite(id) || !['3m', '6m', '12m'].includes(which)) {
        res.status(400).json({ error: 'id and review (3m|6m|12m) required' });
        return;
      }
      const data = await readJson(req);
      const outcome = (data.outcome || '').toString().slice(0, 4000);
      if (!outcome) {
        res.status(400).json({ error: 'outcome required' });
        return;
      }
      const patch = {
        [`review_${which}_outcome`]: outcome,
        [`review_${which}_done_at`]: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (data.lesson_learned) {
        patch.lesson_learned = data.lesson_learned.toString().slice(0, 4000);
      }
      const updated = await sbUpdate('decision_journal', `id=eq.${id}`, patch);
      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated });
      return;
    }

    // ── List all ───────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sbSelect('decision_journal', 'select=*&order=decision_date.desc,id.desc&limit=1000');
      res.status(200).json({ items: rows });
      return;
    }

    // ── Create ─────────────────────────────────────
    if (req.method === 'POST') {
      const data = await readJson(req);
      const ticker = (data.ticker || '').toString().toUpperCase().trim();
      const type = (data.decision_type || '').toString().toUpperCase().trim();
      const decisionDate = (data.decision_date || '').toString().trim();
      const thesis = (data.thesis || '').toString().trim();

      if (!ticker || ticker.length > 12) {
        res.status(400).json({ error: 'ticker required (max 12 chars)' });
        return;
      }
      if (!VALID_TYPES.includes(type)) {
        res.status(400).json({ error: `decision_type must be one of: ${VALID_TYPES.join(', ')}` });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) {
        res.status(400).json({ error: 'decision_date must be YYYY-MM-DD' });
        return;
      }
      if (!thesis) {
        res.status(400).json({ error: 'thesis required' });
        return;
      }

      // ── SELL-specific validation: post-mortem fields ────────────────────
      const isSell = (type === 'SELL');
      const lessonLearned = (data.lesson_learned || '').toString().trim();
      const thesisOutcome = (data.thesis_outcome || '').toString().trim() || null;
      const triggeredFmId = data.triggered_failure_mode_id != null && data.triggered_failure_mode_id !== ''
        ? parseInt(data.triggered_failure_mode_id, 10) : null;
      const linkedBuyId = data.linked_buy_id != null && data.linked_buy_id !== ''
        ? parseInt(data.linked_buy_id, 10) : null;

      if (isSell) {
        if (lessonLearned.length < 50) {
          res.status(400).json({ error: 'lesson_learned required for SELL (min 50 chars) — what did you learn from this position?' });
          return;
        }
        if (thesisOutcome && !VALID_OUTCOMES.includes(thesisOutcome)) {
          res.status(400).json({ error: `thesis_outcome must be one of: ${VALID_OUTCOMES.join(', ')}` });
          return;
        }
        if (!thesisOutcome) {
          res.status(400).json({ error: 'thesis_outcome required for SELL (played_out|partially|failed)' });
          return;
        }
      }

      const rec = {
        ticker,
        decision_type: type,
        decision_date: decisionDate,
        price_at_decision: data.price_at_decision != null && data.price_at_decision !== '' ? Number(data.price_at_decision) : null,
        thesis: thesis.slice(0, 8000),
        catalysts: isSell ? [] : (Array.isArray(data.catalysts) ? data.catalysts.slice(0, 12).map(s => String(s).slice(0, 200)) : []),
        pre_mortem: isSell ? null : ((data.pre_mortem || '').toString().slice(0, 4000) || null),
        // Future-looking reviews don't apply to SELL (position is closed)
        review_3m_date: isSell ? null : addMonths(decisionDate, 3),
        review_6m_date: isSell ? null : addMonths(decisionDate, 6),
        review_12m_date: isSell ? null : addMonths(decisionDate, 12),
        linked_holding: (data.linked_holding || '').toString().slice(0, 200) || null,
        // SELL-specific post-mortem fields
        lesson_learned: lessonLearned ? lessonLearned.slice(0, 4000) : null,
        thesis_outcome: isSell ? thesisOutcome : null,
        triggered_failure_mode_id: isSell ? (Number.isFinite(triggeredFmId) && triggeredFmId > 0 ? triggeredFmId : null) : null,
        linked_buy_id: isSell || type === 'TRIM' ? (Number.isFinite(linkedBuyId) && linkedBuyId > 0 ? linkedBuyId : null) : null,
        created_by: auth.email || null,
        active: true,
      };
      const created = await sbInsert('decision_journal', rec);
      const item = Array.isArray(created) ? created[0] : created;

      // ── Auto-archive pre-mortem when SELL closes the position ───────────
      let archive = null;
      if (isSell) {
        try {
          archive = await archivePremortemForTicker(ticker);
        } catch (e) {
          // Don't block the journal entry on archive failure; log + continue.
          console.error('[admin/journal] archivePremortemForTicker failed:', e.message);
          archive = { error: e.message };
        }
      }

      // ── Auto-transition pipeline_card stage ─────────────────────────────
      let stageSync = null;
      try {
        if (type === 'SELL')      stageSync = await pipelineStage.onSellDecision(ticker);
        else if (type === 'PASS') stageSync = await pipelineStage.onPassDecision(ticker);
      } catch (e) {
        console.warn('[admin/journal POST] pipeline stage transition failed', e.message);
      }

      res.status(200).json({ ok: true, item, archive, stageSync });
      return;
    }

    // ── Update ─────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      const data = await readJson(req);
      const patch = { updated_at: new Date().toISOString() };
      const allowed = [
        'ticker', 'decision_type', 'decision_date', 'price_at_decision',
        'thesis', 'catalysts', 'pre_mortem',
        'review_3m_date', 'review_6m_date', 'review_12m_date',
        'lesson_learned', 'linked_holding', 'active',
        'thesis_outcome', 'triggered_failure_mode_id', 'linked_buy_id',
      ];
      for (const k of allowed) if (k in data) patch[k] = data[k];
      if (patch.ticker) patch.ticker = String(patch.ticker).toUpperCase().trim();
      if (patch.decision_type && !VALID_TYPES.includes(patch.decision_type)) {
        res.status(400).json({ error: 'invalid decision_type' });
        return;
      }
      if (patch.thesis_outcome && !VALID_OUTCOMES.includes(patch.thesis_outcome)) {
        res.status(400).json({ error: 'invalid thesis_outcome' });
        return;
      }

      // Detect SELL state transitions to keep pre-mortem state consistent
      const before = await sbSelect('decision_journal', `select=id,ticker,decision_type,active&id=eq.${id}&limit=1`);
      const prev = before[0] || null;
      const wasActiveSell = prev && prev.decision_type === 'SELL' && prev.active !== false;
      const willBeActiveSell = (patch.decision_type !== undefined ? patch.decision_type : prev?.decision_type) === 'SELL'
        && (patch.active !== undefined ? patch.active : prev?.active) !== false;
      const tickerForChange = (patch.ticker || prev?.ticker || '').toUpperCase();

      const updated = await sbUpdate('decision_journal', `id=eq.${id}`, patch);

      let premortemSync = null;
      if (tickerForChange) {
        if (!wasActiveSell && willBeActiveSell) {
          // Became SELL → archive pre-mortem
          try { premortemSync = { action: 'archived', ...(await archivePremortemForTicker(tickerForChange)) }; }
          catch (e) { premortemSync = { action: 'archive_failed', error: e.message }; }
        } else if (wasActiveSell && !willBeActiveSell) {
          // Was SELL, no longer is → reactivate pre-mortem
          try { premortemSync = { action: 'reactivated', ...(await reactivatePremortemForTicker(tickerForChange)) }; }
          catch (e) { premortemSync = { action: 'reactivate_failed', error: e.message }; }
        }
      }

      // ── Pipeline stage sync on PATCH (handle SELL/PASS transitions both ways) ──
      let stageSync = null;
      if (tickerForChange) {
        const wasActivePass = prev && prev.decision_type === 'PASS' && prev.active !== false;
        const willBeActivePass = (patch.decision_type !== undefined ? patch.decision_type : prev?.decision_type) === 'PASS'
          && (patch.active !== undefined ? patch.active : prev?.active) !== false;
        try {
          if (!wasActiveSell && willBeActiveSell)        stageSync = await pipelineStage.onSellDecision(tickerForChange);
          else if (wasActiveSell && !willBeActiveSell)   stageSync = await pipelineStage.revertFromClosed(tickerForChange);
          else if (!wasActivePass && willBeActivePass)   stageSync = await pipelineStage.onPassDecision(tickerForChange);
          else if (wasActivePass && !willBeActivePass)   stageSync = await pipelineStage.revertFromPassed(tickerForChange);
        } catch (e) {
          console.warn('[admin/journal PATCH] pipeline stage sync failed', e.message);
        }
      }

      res.status(200).json({ ok: true, item: Array.isArray(updated) ? updated[0] : updated, premortemSync, stageSync });
      return;
    }

    // ── Soft delete ────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id || '', 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'id required' });
        return;
      }
      // Look up the row first to know if reactivation is needed
      const before = await sbSelect('decision_journal', `select=id,ticker,decision_type,active&id=eq.${id}&limit=1`);
      const prev = before[0] || null;
      await sbUpdate('decision_journal', `id=eq.${id}`, { active: false, updated_at: new Date().toISOString() });

      let premortemSync = null;
      if (prev && prev.decision_type === 'SELL' && prev.active !== false && prev.ticker) {
        try { premortemSync = { action: 'reactivated', ...(await reactivatePremortemForTicker(prev.ticker)) }; }
        catch (e) { premortemSync = { action: 'reactivate_failed', error: e.message }; }
      }

      // ── Pipeline stage revert on soft-delete of active SELL or PASS ──
      let stageSync = null;
      if (prev && prev.active !== false && prev.ticker) {
        try {
          if (prev.decision_type === 'SELL')      stageSync = await pipelineStage.revertFromClosed(prev.ticker);
          else if (prev.decision_type === 'PASS') stageSync = await pipelineStage.revertFromPassed(prev.ticker);
        } catch (e) {
          console.warn('[admin/journal DELETE] pipeline stage revert failed', e.message);
        }
      }

      res.status(200).json({ ok: true, premortemSync, stageSync });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
