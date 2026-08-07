-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: "Added to the roster — a real login account still needs sign-up"
--
-- Adding a resource in Resources → Add New Resource never reached the
-- database. Two reasons, both in the schema:
--
--   1. profiles.id is a uuid, and the app was sending a short generated id.
--      (Fixed in the app — it now sends a real uuid.)
--   2. profiles.id REFERENCES auth.users(id). A person who has not signed up
--      yet has no auth user, so the row was rejected by the foreign key. The
--      resource only ever lived in the browser, and vanished on refresh.
--
-- And when that person did eventually sign up, the sign-up trigger inserted a
-- BRAND NEW profile — fresh uuid, role 'engineer', name taken from the email
-- — with no connection to the roster entry the PM had filled in. Their dept,
-- title, skills and capacity were lost, and the team list showed them twice.
--
-- This migration separates the two ideas that were sharing one column:
--
--   profiles.id       — who this person IS on the roster. Stable for ever.
--                       Project assignments and tasks point at it.
--   profiles.auth_id  — the login they use, once they have one. Empty until
--                       they sign up.
--
-- A resource can now be created before the person has an account, and signing
-- up ADOPTS their existing roster row by email instead of duplicating it.
--
-- Idempotent: safe to re-run. Run it in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Let a roster row exist without a login ──────────────────────────────
alter table public.profiles
  drop constraint if exists profiles_id_fkey;

alter table public.profiles
  add column if not exists auth_id uuid;

-- One login can only be one person.
create unique index if not exists profiles_auth_id_key
  on public.profiles (auth_id) where auth_id is not null;

-- A row that came FROM a sign-up has an id that IS an auth user id. Say so.
-- Only those: a workspace can also hold roster rows with no login behind them
-- (the setup script, an earlier partial fix), and claiming those have a login
-- would point them at an account that does not exist — and would stop the
-- fold below from ever recognising them.
update public.profiles p
   set auth_id = p.id
 where p.auth_id is null
   and exists (select 1 from auth.users u where u.id = p.id);

-- ── 2. Fold anyone the old flow split across two rows ──────────────────────
-- Under the old behaviour a resource a PM added never reached the database,
-- so when that person eventually signed up they arrived as a stranger. A
-- workspace that got the roster row in some other way — the setup script, an
-- earlier partial migration — ends up with two rows for one person.
--
-- This has to run BEFORE the unique index below, or the index cannot be
-- built and the whole migration stops here.
do $$
declare r record;
begin
  for r in
    select roster.id as roster_id, login.id as login_id, login.auth_id as login_auth
      from public.profiles roster
      join public.profiles login
        on lower(roster.email) = lower(login.email)
       and roster.id <> login.id
     where roster.auth_id is null
       and login.auth_id is not null
       and roster.email is not null and roster.email <> ''
  loop
    -- Keep the ROSTER row: project assignments and tasks point at its id.
    -- It just gains the login the other row was holding. Let go of the login
    -- on the losing row first — one login cannot sit on two rows even for an
    -- instant, and the unique index says so.
    update public.profiles set auth_id = null where id = r.login_id;
    update public.profiles set auth_id = r.login_auth where id = r.roster_id;
    delete from public.profiles where id = r.login_id;
    raise notice 'folded a duplicated person back into one row (%)', r.roster_id;
  end loop;
end $$;

-- Matching a sign-up to a roster entry is done on email, so it should be fast
-- and case-insensitive. Best-effort: if a workspace still has two people
-- sharing an email in a way this migration cannot judge, that is for a human
-- to settle — it must not stop the rest of the fix from landing.
do $$
begin
  create unique index if not exists profiles_email_lower_key
    on public.profiles (lower(email)) where email is not null and email <> '';
exception when unique_violation then
  raise notice 'Two people share an email — the roster still works, but tidy them up: select email, count(*) from public.profiles where email <> '''' group by 1 having count(*) > 1;';
end $$;

-- ── 3. Signing up adopts the roster entry instead of duplicating it ────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  existing public.profiles%rowtype;
  cnt int;
begin
  -- Did a PM already add this person as a resource? Then this sign-up is
  -- their login arriving, not a new person. Keep their id, their role and
  -- everything the PM filled in; just record the login.
  select * into existing
    from public.profiles
   where auth_id is null
     and lower(email) = lower(new.email)
   limit 1;

  if found then
    update public.profiles
       set auth_id = new.id,
           name    = coalesce(nullif(name, ''), new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
     where id = existing.id;
    return new;
  end if;

  -- Nobody was expecting them — create the row. The very first account in an
  -- empty workspace is the superadmin.
  select count(*) into cnt from public.profiles;
  insert into public.profiles (id, auth_id, email, name, role, color)
  values (
    new.id,
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when cnt = 0 then 'superadmin' else 'engineer' end,
    '#2563eb'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 4. "Is this me?" now means the login, not the roster id ────────────────
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where coalesce(auth_id, id) = auth.uid()
       and role in ('superadmin', 'dept_head')
  );
$$;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (coalesce(auth_id, id) = auth.uid())
  with check (coalesce(auth_id, id) = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (coalesce(auth_id, id) = auth.uid());

-- An admin may add a person who has no login yet — that is the whole point.
drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated with check (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_admin());

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

-- ── 5. Check ───────────────────────────────────────────────────────────────
select
  count(*)                                   as people,
  count(*) filter (where auth_id is not null) as with_a_login,
  count(*) filter (where auth_id is null)     as awaiting_signup
from public.profiles;
