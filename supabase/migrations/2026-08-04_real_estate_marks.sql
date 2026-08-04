-- Historical marks for the Real Estate sleeve.
-- Each row is one GP-published NAV mark for one position.
-- The endpoint picks the most recent mark with mark_date <= as_of. Between
-- deployment and the first mark, NAV = capital contribution at par (no row
-- needed in this table — the fallback lives in the endpoint).

CREATE TABLE IF NOT EXISTS real_estate_marks (
  id             BIGSERIAL PRIMARY KEY,
  position_id    TEXT NOT NULL,               -- matches the id field in real_estate_positions.json
  mark_date      DATE NOT NULL,               -- GP-reported valuation date
  reported_at    DATE,                        -- when GP published the report (informational)
  nav_eur        NUMERIC(18,2) NOT NULL,      -- NAV in EUR at the mark
  moic_eur       NUMERIC(8,4),                -- MOIC as reported by GP (optional cross-check)
  report_period  TEXT,                        -- 'S1-2025', 'S2-2025', 'S1-2026', ...
  source         TEXT,                        -- 'AX Partners S1 2026 Report (created 03/08/2026)' etc.
  gp_commentary  TEXT,                        -- free-text GP note on the position that period
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_marks_pos_date
  ON real_estate_marks(position_id, mark_date DESC);
CREATE INDEX IF NOT EXISTS idx_re_marks_date
  ON real_estate_marks(mark_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_re_marks_pos_date
  ON real_estate_marks(position_id, mark_date);

COMMENT ON TABLE real_estate_marks IS
  'Historical GP-published NAV marks for private RE positions. Supports as-of queries by picking the most recent mark_date <= requested date.';
