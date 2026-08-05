-- ═══════════════════════════════════════════════════════════════════════════
-- ELECBITS ODM PMS — ONE-SHOT FIX
-- Paste this whole file into the Supabase SQL editor and press Run.
-- Safe to re-run. Combines:
--   1. app_kv table + grants        → stops the 401, data saves to Postgres
--   2. profile columns              → Department / role / skills / capacity persist
--   3. admin roster policies        → admins can add/edit/remove anyone
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. KEY/VALUE STORE (fixes: 401 on /rest/v1/app_kv) ─────────────────────
create table if not exists public.app_kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_kv enable row level security;
drop policy if exists app_kv_auth_all on public.app_kv;
create policy app_kv_auth_all on public.app_kv
  for all to authenticated using (true) with check (true);

-- ── 2. PROFILE COLUMNS (fixes: Department lost on refresh) ─────────────────
alter table public.profiles add column if not exists dept          text;
alter table public.profiles add column if not exists resource_role text;
alter table public.profiles add column if not exists skills        jsonb default '[]'::jsonb;
alter table public.profiles add column if not exists max_projects  int;
alter table public.profiles add column if not exists project_tags  jsonb default '[]'::jsonb;

-- ── 3. ADMIN ROSTER MANAGEMENT (fixes: RLS violation editing others) ───────
-- SECURITY DEFINER so a policy on profiles can read profiles without recursing.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('superadmin', 'dept_head')
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated with check (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_admin());

-- ── 4. GRANTS (RLS alone isn't enough for PostgREST — this is the 401) ─────
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ── 5. VERIFY ──────────────────────────────────────────────────────────────
insert into public.app_kv (key, value) values ('healthcheck', 'ok')
  on conflict (key) do update set value = 'ok', updated_at = now();

select 'app_kv writable' as check, value as result from public.app_kv where key = 'healthcheck'
union all
select 'profile columns', string_agg(column_name, ', ' order by column_name)
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name in ('dept','resource_role','skills','max_projects','project_tags')
union all
select 'admin policies', count(*)::text || ' installed'
  from pg_policies where schemaname = 'public' and tablename = 'profiles'
    and policyname like 'profiles_admin%';
