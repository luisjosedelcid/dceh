-- ═══════════════════════════════════════════════════════════════════
-- IDEA FEED — DCE Holdings Investment Office
-- Tracks RSS-based stock idea sources (blogs, Substacks, podcasts)
-- and extracts ticker mentions via regex + LLM fallback.
-- ═══════════════════════════════════════════════════════════════════

-- ── Sources catalog ────────────────────────────────────────────────
create table if not exists idea_feed_sources (
  id          bigserial primary key,
  name        text not null,
  url         text not null,                 -- canonical website URL
  rss_url     text not null,                 -- RSS/Atom feed URL
  kind        text not null default 'blog',  -- blog|substack|podcast
  is_paid     boolean not null default false,-- true if paywalled (preview-only)
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists idea_feed_sources_rss_uniq on idea_feed_sources (rss_url);

-- ── Items extracted from feeds ─────────────────────────────────────
create table if not exists idea_feed_items (
  id                bigserial primary key,
  source_id         bigint not null references idea_feed_sources(id) on delete cascade,
  guid              text not null,            -- RSS <guid> or fallback URL
  url               text,
  title             text not null,
  snippet           text,                     -- first ~500 chars of description
  published_at      timestamptz,
  tickers           text[] not null default '{}',
  extraction_method text not null default 'regex', -- regex|llm|none
  fetched_at        timestamptz not null default now()
);

create unique index if not exists idea_feed_items_source_guid_uniq
  on idea_feed_items (source_id, guid);

create index if not exists idea_feed_items_published_idx
  on idea_feed_items (published_at desc nulls last);

create index if not exists idea_feed_items_tickers_gin
  on idea_feed_items using gin (tickers);

-- ── Seed: 6 starter sources ────────────────────────────────────────
insert into idea_feed_sources (name, url, rss_url, kind, is_paid, notes) values
  ('Roberto Chamorro / InvirtiendoME', 'https://robertochamorrogilaberte.substack.com', 'https://robertochamorrogilaberte.substack.com/feed', 'substack', false, 'Spanish-language value investing'),
  ('The Brooklyn Investor',            'https://brklyninvestor.com',                     'https://brklyninvestor.com/feed/',                   'blog',     false, 'Long-form value commentary'),
  ('Bedrock AI / Hudson Labs',         'https://bedrock.substack.com',                   'https://bedrock.substack.com/feed',                  'substack', false, 'AI-driven SEC filings analysis'),
  ('Howard Marks Memos',               'https://www.oaktreecapital.com',                 'https://rss.art19.com/the-memo-by-howard-marks',     'podcast',  false, 'Oaktree memo audio podcast'),
  ('Acquired',                         'https://acquired.fm',                            'https://feeds.transistor.fm/acquired',               'podcast',  false, 'Gilbert & Rosenthal — company deep dives'),
  ('Net Interest (Marc Rubinstein)',   'https://www.netinterest.co',                     'https://www.netinterest.co/feed',                    'substack', false, 'Financials sector — public RSS preview')
on conflict (rss_url) do nothing;
