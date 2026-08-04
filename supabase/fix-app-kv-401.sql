-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: 401 on /rest/v1/app_kv  (data not saving to Supabase)
--
-- Symptom in the browser console:
--   Failed to load resource: .../rest/v1/app_kv  401
--
-- Cause: either the table doesn't exist yet (schema.sql never run), or it
-- exists without the table-level grants PostgREST needs — RLS policies alone
-- are not enough.
--
-- Safe to run on its own, and safe to re-run. Paste into the Supabase SQL
-- editor and press Run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. The key/value table the app persists into.
create table if not exists public.app_kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- 2. Privileges (the usual cause of the 401).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.app_kv to authenticated;

-- 3. Row-level security: any signed-in user may read/write the shared state.
alter table public.app_kv enable row level security;
drop policy if exists app_kv_auth_all on public.app_kv;
create policy app_kv_auth_all on public.app_kv
  for all to authenticated using (true) with check (true);

-- 4. Verify — should return a row you just wrote.
insert into public.app_kv (key, value)
values ('healthcheck', 'ok')
on conflict (key) do update set value = 'ok', updated_at = now();

select key, value, updated_at from public.app_kv where key = 'healthcheck';
