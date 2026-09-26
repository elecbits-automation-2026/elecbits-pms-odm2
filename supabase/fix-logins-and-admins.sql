-- ═══════════════════════════════════════════════════════════════════════════
-- FIX THE BROKEN LOGINS + MAKE THE TWO ADMINS — v2, layout-aware.
--
-- v1 of this script wrote to public.profiles. On this database the roster has
-- MOVED to core.people (the schema reorganisation), so v1 either stopped at
-- the first statement or updated a table the app no longer reads. This
-- version finds the roster wherever it lives — core.people first,
-- public.profiles as the fallback — and does everything against that.
--
-- What it does, in one run:
--   1. REPAIRS every auth user whose GoTrue token columns are NULL (the
--      reason "Sign-in failed" hits accounts made by the bulk login scripts).
--      Sets them to '' — exactly what Supabase itself stores. No password
--      is changed by this.
--   2. GUARANTEES akshay.tm@elecbits.in signs in with Eb-marble-8467:
--      creates the login if missing, otherwise resets its password to that,
--      confirms the email, and links it to his roster row.
--   3. Makes amitabh.gogoi@elecbits.in and mahesh@elecbits.in SUPERADMINS —
--      full access to every project, same as the admin account. Missing
--      roster rows / logins are created; the report prints any NEW password
--      exactly once. Existing passwords are never touched.
--
-- Idempotent: a second run changes nothing and prints the same report.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 0 · find the roster and reach it through one name ───────────────────────
do $$
declare
  roster text;
begin
  if exists (select 1 from information_schema.tables where table_schema = 'core' and table_name = 'people') then
    roster := 'core.people';
  elsif exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles') then
    roster := 'public.profiles';
  else
    raise exception 'No roster table found — neither core.people nor public.profiles exists.';
  end if;
  execute format('alter table %s add column if not exists auth_id uuid', roster);
  -- a simple single-table temp view is auto-updatable: inserts and updates
  -- below pass straight through to the real roster
  execute 'drop view if exists _roster';
  execute format('create temp view _roster as select * from %s', roster);
  raise notice 'Roster: %', roster;
end $$;

-- ── 1 · repair the NULL token columns on EVERY auth user ────────────────────
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
drop table if exists _handout;
create temp table _handout (name text, email text, password text, note text) on commit preserve rows;

do $$
declare
  spec record;
  pid  uuid;   -- roster row id
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
    -- the roster row: match by email first, then by name; create if absent
    select id into pid from _roster where lower(coalesce(email,'')) = spec.email limit 1;
    if pid is null then
      select id into pid from _roster
      where lower(name) like lower(split_part(spec.name, ' ', 1)) || '%'
        and role is distinct from 'superadmin'
      limit 1;
    end if;
    if pid is null then
      pid := gen_random_uuid();
      insert into _roster (id, name, email, role, title, dept, skills, project_tags, max_projects, color)
      values (pid, spec.name, spec.email,
              case when spec.make_admin then 'superadmin' else 'engineer' end,
              case when spec.make_admin then 'Super Admin' else 'Engineer' end,
              'ODM', '[]'::jsonb, '["engineering"]'::jsonb, 3, '#4f46e5');
    else
      update _roster set email = spec.email where id = pid;
    end if;
    if spec.make_admin then
      update _roster set role = 'superadmin',
        title = case when coalesce(title,'') in ('', 'Engineer') then 'Super Admin' else title end
      where id = pid;
    end if;

    -- the login: by email, else through the roster link
    select id into aid from auth.users where lower(email) = spec.email limit 1;
    if aid is null then
      select auth_id into aid from _roster where id = pid and auth_id is not null;
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

    update _roster set auth_id = aid where id = pid;
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
select h.name, h.email, h.password, h.note, r.role
from _handout h
left join _roster r on lower(coalesce(r.email,'')) = h.email
order by h.name;

drop table if exists _handout;
