-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: "new row violates row-level security policy for table profiles"
--
-- Symptom: editing / adding / removing anyone OTHER than yourself in
-- Resources fails, while editing your own row succeeds.
--
-- Cause: the original policies only allowed a user to write their own profile
-- row, so admins could not manage the team roster.
--
-- This adds admin-wide manage rights, decided by the caller's own `role` in
-- profiles. Reading that role from inside a profiles policy would recurse, so
-- it goes through a SECURITY DEFINER helper that bypasses RLS.
--
-- Safe to re-run. Paste into the Supabase SQL editor and press Run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Helper: is the current user an admin? SECURITY DEFINER avoids RLS
--    recursion when the policy on `profiles` needs to read `profiles`.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('superadmin', 'dept_head')
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 2. Policies on profiles.
alter table public.profiles enable row level security;

-- everyone signed in can read the roster
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

-- you may always edit your own row
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- admins may create / edit / remove ANY profile (roster management)
drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated with check (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_admin());

-- 3. Table privileges (RLS alone isn't enough for PostgREST).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

-- 4. Verify: should return true when run as an admin from the app.
--    (In the SQL editor auth.uid() is null, so this shows false here — that's
--    expected. The real check is that roster edits now work in the app.)
select public.is_admin() as am_i_admin_in_this_session;
