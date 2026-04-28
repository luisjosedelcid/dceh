-- ============================================================
-- DCE Reporting Hub — Quick Wins schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1) admin_users — multi-user real (currently seeded with Luis)
create table if not exists public.admin_users (
  id           uuid primary key default gen_random_uuid(),
  email        text unique not null,
  display_name text not null,
  password_hash text not null,        -- bcrypt
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  last_login   timestamptz
);

-- 2) report_audit — log of every upload/delete/archive
create table if not exists public.report_audit (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  actor_email text not null,
  action      text not null check (action in ('upload','delete','archive','login')),
  folder      text,
  filename    text,
  size_bytes  bigint,
  detail      text
);

create index if not exists report_audit_ts_idx on public.report_audit (ts desc);
create index if not exists report_audit_folder_idx on public.report_audit (folder);

-- Lock down with RLS — service role bypasses RLS so the API still works
alter table public.admin_users enable row level security;
alter table public.report_audit enable row level security;

-- No anon access. (Service-role key in our APIs bypasses RLS automatically.)

-- ============================================================
-- Seed Luis (replace the bcrypt hash before running if needed)
-- The API will seed this row idempotently on first login attempt
-- if the table is empty, so you can leave this commented out.
-- ============================================================
-- insert into public.admin_users (email, display_name, password_hash)
-- values ('luis@dceholdings.com','Luis del Cid','$2b$12$REPLACE_WITH_REAL_HASH')
-- on conflict (email) do nothing;
