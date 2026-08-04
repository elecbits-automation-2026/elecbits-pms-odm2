-- ═══════════════════════════════════════════════════════════════════════════
-- Elecbits ODM PMS — Supabase schema
-- Run this in the Supabase SQL editor (Dashboard → SQL) once per project.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) app_kv — the key/value store that backs window.storage in the frontend.
--    The app writes two JSON blobs ("pms-v1-a", "pms-v1-b"); this is where the
--    projects, tasks, notes, KPIs, work updates, trainings and memory live.
create table if not exists public.app_kv (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- 2) drive_sync_log — durable server-side record of every Drive/Sheets sync
--    event (also mirrored to Google Sheets by the drive-sync Edge Function).
create table if not exists public.drive_sync_log (
  id          bigint generated always as identity primary key,
  target      text,
  detail      text,
  at          timestamptz not null default now()
);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- This is an internal team tool with shared org state. The policies below let
-- the anon key read/write app_kv so the app works out of the box. TIGHTEN THIS
-- before any public exposure: put Supabase Auth in front and scope by user/org.
alter table public.app_kv enable row level security;
alter table public.drive_sync_log enable row level security;

drop policy if exists app_kv_all on public.app_kv;
create policy app_kv_all on public.app_kv
  for all to anon, authenticated using (true) with check (true);

drop policy if exists drive_sync_log_rw on public.drive_sync_log;
create policy drive_sync_log_rw on public.drive_sync_log
  for all to anon, authenticated using (true) with check (true);
