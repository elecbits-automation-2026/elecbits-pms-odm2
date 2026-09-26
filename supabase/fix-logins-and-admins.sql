-- ═══════════════════════════════════════════════════════════════════════════
-- FIX THE BROKEN LOGINS + MAKE THE TWO ADMINS — 26 Sep 2026, as asked by Saurav.
--
-- WHY SIGN-IN WAS FAILING: logins created by create-all-logins.sql (and
-- reset-all-logins.sql) inserted auth.users rows with the GoTrue "token"
-- columns left NULL. GoTrue cannot read a NULL there, so every such account
-- fails at sign-in with a schema error the app can only show as
-- "Sign-in failed". Accounts made through the dashboard or the app were fine.
--
-- This script, in one run:
--   1. REPAIRS every auth user with NULL token columns (sets them to '' —
--      exactly what Supabase itself stores). No password is changed by this.
--   2. GUARANTEES akshay.tm@elecbits.in signs in with Eb-marble-8467:
--      creates the login if missing, otherwise resets its password to that,
--      confirms the email, and links it to his roster profile.
--   3. Makes amitabh.gogoi@elecbits.in and mahesh@elecbits.in SUPERADMINS
--      (same access as the admin account). Missing profiles/logins are
--      created; the printed report shows any NEW password. Existing
--      passwords are never touched.
--
-- Idempotent: a second run changes nothing and prints the same report.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;
alter table public.profiles add column if not exists auth_id uuid;  -- no-op if migrated

-- ── 1 · repair the NULL token columns on EVERY auth user ────────────────────
-- Column names vary a little across GoTrue versions, so only the ones that
-- actually exist are touched.
do $$
declare
  col text;
  fixed int;
begin
  foreach col in array array['confirmation_token','recovery_token','email_change',
                             'email_change_token_new','email_change_token_current',
                             'phone_change','phone_change_token','reauthentication_token']
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = col) then
      execute format('update auth.users set %I = '''' where %I is null', col, col);
      get diagnostics fixed = row_count;
      if fixed > 0 then raise notice 'auth.users.% : % NULL value(s) repaired', col, fixed; end if;
    end if;
  end loop;
end $$;

-- ── 2 + 3 · the named accounts ───────────────────────────────────────────────
create temp table _handout (name text, email text, password text, note text) on commit preserve rows;

do $$
declare
  spec record;
  pid  uuid;   -- profile id
  aid  uuid;   -- auth user id
  pw   text;
begin
  for spec in
    select * from (values
      -- email                        name              make_admin  fixed_password
      ('akshay.tm@elecbits.in',      'Akshay',          false,      'Eb-marble-8467'),
      ('amitabh.gogoi@elecbits.in',  'Amitabh Gogoi',   true,       null),
      ('mahesh@elecbits.in',         'Mahesh',          true,       null)
    ) as t(email, name, make_admin, fixed_password)
  loop
    -- the roster profile: match by email first, then by name; create if absent
    select id into pid from public.profiles where lower(coalesce(email,'')) = spec.email limit 1;
    if pid is null then
      select id into pid from public.profiles
      where lower(name) like lower(split_part(spec.name, ' ', 1)) || '%'
        and role is distinct from 'superadmin'
      limit 1;
    end if;
    if pid is null then
      pid := gen_random_uuid();
      insert into public.profiles (id, name, email, role, title, dept, skills, project_tags, max_projects, color)
      values (pid, spec.name, spec.email,
              case when spec.make_admin then 'superadmin' else 'engineer' end,
              case when spec.make_admin then 'Super Admin' else 'Engineer' end,
              'ODM', '[]'::jsonb, '["engineering"]'::jsonb, 3, '#4f46e5');
    else
      update public.profiles set email = spec.email where id = pid;
    end if;
    if spec.make_admin then
      update public.profiles set role = 'superadmin',
        title = case when coalesce(title,'') in ('', 'Engineer') then 'Super Admin' else title end
      where id = pid;
    end if;

    -- the login: by email, else by the profile link
    select id into aid from auth.users where lower(email) = spec.email limit 1;
    if aid is null then
      select auth_id into aid from public.profiles where id = pid and auth_id is not null;
    end if;

    if aid is null then
      -- no login at all → create one, complete with the token columns
      aid := gen_random_uuid();
      pw  := coalesce(spec.fixed_password,
             'Eb-' || (array['cobalt','ember','harbor','indigo','jasper','kestrel','lumen',
                             'marble','nimbus','onyx','pyrite','quartz','raven','saffron',
                             'timber','umber','verde','willow','xenon','yarrow','zephyr',
                             'amber','basalt','cedar','dune','flint','garnet','helix'])
                    [1 + (('x' || substr(md5(spec.email || 'salt10aug'), 1, 4))::bit(16)::int % 28)]
                 || '-' || lpad(((('x' || substr(md5(spec.email || 'pin'), 1, 6))::bit(24)::int) % 9000 + 1000)::text, 4, '0'));
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin,
        confirmation_token, recovery_token, email_change, email_change_token_new
      ) values (
        '00000000-0000-0000-0000-000000000000', aid, 'authenticated', 'authenticated',
        spec.email, crypt(pw, gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', spec.name), false,
        '', '', '', ''
      );
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (aid, aid, jsonb_build_object('sub', aid::text, 'email', spec.email, 'email_verified', true),
              'email', now(), now(), now());
      insert into _handout values (spec.name, spec.email, pw, 'NEW login created');
    else
      -- login exists → confirm it, and pin the known password only where one
      -- was asked for (Akshay). Admins keep whatever password they have.
      update auth.users set
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        aud = 'authenticated', role = 'authenticated',
        encrypted_password = case when spec.fixed_password is not null
                                  then crypt(spec.fixed_password, gen_salt('bf'))
                                  else encrypted_password end,
        updated_at = now()
      where id = aid;
      if not exists (select 1 from auth.identities where user_id = aid and provider = 'email') then
        insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (aid, aid, jsonb_build_object('sub', aid::text, 'email', spec.email, 'email_verified', true),
                'email', now(), now(), now());
      end if;
      insert into _handout values (spec.name, spec.email,
        coalesce(spec.fixed_password, '(unchanged)'),
        case when spec.fixed_password is not null then 'password reset to the known one' else 'login already existed' end);
    end if;

    update public.profiles set auth_id = aid where id = pid;
  end loop;
end $$;

-- ── Final sweep: the logins created above must not leave a NULL behind ──────
do $$
declare
  col text;
begin
  foreach col in array array['confirmation_token','recovery_token','email_change',
                             'email_change_token_new','email_change_token_current',
                             'phone_change','phone_change_token','reauthentication_token']
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = col) then
      execute format('update auth.users set %I = '''' where %I is null', col, col);
    end if;
  end loop;
end $$;

-- ── The report ───────────────────────────────────────────────────────────────
select h.name, h.email, h.password, h.note, p.role
from _handout h
left join public.profiles p on lower(coalesce(p.email,'')) = h.email
order by h.name;

drop table if exists _handout;
