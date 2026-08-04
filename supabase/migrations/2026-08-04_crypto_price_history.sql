-- Historical daily-close crypto prices for time-travel valuations
-- of the Crypto sleeve. Populated by:
--   1) a one-time backfill from CoinGecko /coins/{id}/market_chart/range
--      (365-day free-tier window),
--   2) a daily 00:15 UTC cron capturing the previous day's spot close.
--
-- Prices are stored in USD (native CoinGecko response). EUR conversion is
-- done at query time from the same ECB source that Real Estate uses, so
-- there is no rate double-book here.

CREATE TABLE IF NOT EXISTS crypto_price_history (
  id            BIGSERIAL PRIMARY KEY,
  coin_id       TEXT        NOT NULL,               -- CoinGecko id (e.g. 'ripple')
  snapshot_date DATE        NOT NULL,               -- UTC calendar date
  price_usd     NUMERIC(20,8) NOT NULL,
  source        TEXT        NOT NULL DEFAULT 'coingecko',
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cph_coin_date
  ON crypto_price_history (coin_id, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_cph_date
  ON crypto_price_history (snapshot_date DESC);
