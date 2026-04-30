-- ═══════════════════════════════════════════════════════════════════════
-- DCE Holdings — Performance Tracking Schema (#4)
-- Migration: performance_tracking_schema
-- ═══════════════════════════════════════════════════════════════════════
-- Tracks transactions, cashflows (dividends/fees/FX), daily prices and FX
-- rates to compute cost basis (FIFO), TWR, IRR, drawdown, and attribution.
-- Reporting currency: USD. Schwab is the primary broker, manual entry
-- supported for any other source.
-- ═══════════════════════════════════════════════════════════════════════

-- ── transactions ─────────────────────────────────────────────────────
-- One row per BUY or SELL. Stored in native currency + FX snapshot to USD
-- so historical reporting is reproducible regardless of current FX.
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty             NUMERIC(20, 8) NOT NULL CHECK (qty > 0),
  price_native    NUMERIC(20, 8) NOT NULL CHECK (price_native >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  fx_to_usd       NUMERIC(20, 8) NOT NULL DEFAULT 1.0 CHECK (fx_to_usd > 0),
  fee_native      NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (fee_native >= 0),
  trade_date      DATE NOT NULL,
  settle_date     DATE,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('schwab_csv', 'manual')),
  external_id     TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_ticker_date ON transactions (ticker, trade_date);
CREATE INDEX IF NOT EXISTS idx_tx_trade_date  ON transactions (trade_date);
-- Idempotency for CSV re-imports
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_external
  ON transactions (source, external_id) WHERE external_id IS NOT NULL;

COMMENT ON COLUMN transactions.fx_to_usd IS
  'FX rate at trade date: 1 unit of currency = X USD. Stored as snapshot so reports remain stable.';
COMMENT ON COLUMN transactions.external_id IS
  'Broker-side transaction identifier when available. Used for idempotent CSV re-imports.';

-- ── cashflows ────────────────────────────────────────────────────────
-- Dividends, fees not tied to a trade, interest, FX gains/losses on cash.
-- Anything that affects portfolio NAV but isn't a buy/sell.
CREATE TABLE IF NOT EXISTS cashflows (
  id              BIGSERIAL PRIMARY KEY,
  cf_type         TEXT NOT NULL CHECK (cf_type IN ('DIVIDEND', 'FEE', 'INTEREST', 'FX_GAIN', 'TAX', 'CONTRIBUTION', 'WITHDRAWAL')),
  ticker          TEXT,                       -- nullable: account-level fees/interest have no ticker
  amount_native   NUMERIC(20, 8) NOT NULL,    -- can be negative (fees, withdrawals)
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  fx_to_usd       NUMERIC(20, 8) NOT NULL DEFAULT 1.0 CHECK (fx_to_usd > 0),
  occurred_at     DATE NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('schwab_csv', 'manual')),
  external_id     TEXT,
  source_tx_id    BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_cf_ticker_date ON cashflows (ticker, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cf_type_date   ON cashflows (cf_type, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cf_external
  ON cashflows (source, external_id) WHERE external_id IS NOT NULL;

COMMENT ON COLUMN cashflows.cf_type IS
  'CONTRIBUTION/WITHDRAWAL = capital flows in/out of the portfolio (used to separate from returns). DIVIDEND/INTEREST/FX_GAIN add to NAV. FEE/TAX subtract.';

-- ── prices_daily ─────────────────────────────────────────────────────
-- EOD close prices in native currency. Used for mark-to-market and TWR.
-- Backfilled from inception (default 2026-01-01) by cron.
CREATE TABLE IF NOT EXISTS prices_daily (
  ticker          TEXT NOT NULL,
  price_date      DATE NOT NULL,
  close_native    NUMERIC(20, 8) NOT NULL CHECK (close_native >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  source          TEXT NOT NULL DEFAULT 'finnhub',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, price_date)
);

CREATE INDEX IF NOT EXISTS idx_prices_date ON prices_daily (price_date);

-- ── fx_daily ─────────────────────────────────────────────────────────
-- Daily FX rates. pair format: 'EURUSD' = how many USD per 1 EUR.
-- Source: ECB exchangerate.host (free, no key, daily ECB reference rates).
CREATE TABLE IF NOT EXISTS fx_daily (
  pair            TEXT NOT NULL CHECK (char_length(pair) = 6),
  rate_date       DATE NOT NULL,
  rate            NUMERIC(20, 8) NOT NULL CHECK (rate > 0),
  source          TEXT NOT NULL DEFAULT 'ecb',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pair, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_date ON fx_daily (rate_date);

COMMENT ON COLUMN fx_daily.rate IS
  'For pair=EURUSD, rate=1.08 means 1 EUR = 1.08 USD. To convert EUR amount to USD: multiply by rate.';

-- ── portfolio_snapshots ──────────────────────────────────────────────
-- Daily portfolio NAV + holdings snapshot. Computed by cron at EOD using
-- prices_daily + transactions FIFO. Avoids recomputing TWR series on every
-- page load; equity curve queries become fast index scans.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  snapshot_date   DATE PRIMARY KEY,
  nav_usd         NUMERIC(20, 4) NOT NULL,
  invested_usd    NUMERIC(20, 4) NOT NULL,    -- net contributions to date
  cash_usd        NUMERIC(20, 4) NOT NULL DEFAULT 0,
  twr_daily       NUMERIC(12, 8),             -- single-day TWR (Modified Dietz)
  twr_cumulative  NUMERIC(12, 8),             -- cumulative TWR since inception
  benchmark_urth  NUMERIC(12, 8),             -- cumulative URTH return since inception
  drawdown_pct    NUMERIC(12, 8),             -- vs running max NAV
  holdings_json   JSONB NOT NULL DEFAULT '[]', -- array of {ticker, qty, cost_basis_usd, mv_usd}
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snap_date ON portfolio_snapshots (snapshot_date DESC);

-- ── tickers_tracked ──────────────────────────────────────────────────
-- Convenience view: distinct tickers ever held + currently watched.
-- Cron uses this to know which prices to fetch daily.
CREATE OR REPLACE VIEW tickers_tracked AS
  SELECT DISTINCT ticker, MIN(trade_date) AS first_trade_date
  FROM transactions
  WHERE ticker IS NOT NULL
  GROUP BY ticker
  UNION
  SELECT 'URTH'::TEXT AS ticker, '2026-01-01'::DATE AS first_trade_date;

COMMENT ON VIEW tickers_tracked IS
  'Tickers that need daily EOD prices: any traded ticker + URTH benchmark.';
