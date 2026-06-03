-- DCE Holdings — Add batch_id to transactions, cashflows, report_audit
-- Run in Supabase SQL editor (project dceh). Safe to re-run (IF NOT EXISTS).
--
-- Rationale: lets us list imports as discrete batches (fecha, archivo, conteo)
-- and bulk-delete a specific import without affecting other imports of the
-- same source. Without this, source='schwab_csv' lumps every Schwab CSV
-- import you've ever done into a single bucket.
--
-- Rows existing BEFORE this migration will have batch_id = NULL — they appear
-- as a "(legacy, pre-batch)" entry in the imports panel and can be deleted in
-- bulk by source as before.

-- ── transactions ─────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_tx_batch_id ON transactions (batch_id)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN transactions.batch_id IS
  'Groups rows inserted in the same import operation. NULL for legacy rows imported before 2026-06-03.';

-- ── cashflows ────────────────────────────────────────
ALTER TABLE cashflows
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_cf_batch_id ON cashflows (batch_id)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN cashflows.batch_id IS
  'Groups rows inserted in the same import operation. NULL for legacy rows imported before 2026-06-03.';

-- ── report_audit ─────────────────────────────────────
ALTER TABLE report_audit
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_audit_batch_id ON report_audit (batch_id)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN report_audit.batch_id IS
  'Links an import audit row to the batch_id stamped on the resulting transactions/cashflows rows.';
