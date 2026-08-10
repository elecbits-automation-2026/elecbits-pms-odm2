-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE A LOGIN FOR EVERYONE — email + password for the whole roster.
--
-- For every person on the roster with an email and no login yet, this creates
-- a real Supabase auth account with a readable password, marks it
-- email-confirmed (so it works immediately and needs no confirmation mail),
-- and links it to their roster entry. It then PRINTS the full list of
-- name / email / password so you can hand them out.
--
-- People who already have a login are left untouched and listed as such — this
-- never resets an existing password (so your own admin account is safe). To
-- reset one deliberately, use Resources → Edit → Set password in the app.
--
-- Passwords are readable-but-unguessable: "Eb-<word>-<4 digits>", e.g.
-- "Eb-cobalt-4827". They are shown ONCE, here. Copy this result out and store
-- it somewhere safe; the database keeps only the bcrypt hash, so it cannot be
-- read back later.
--
-- Idempotent: re-running creates logins only for people who still lack one and
-- prints everyone (with a blank password for those whose login already
-- existed before this run).
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- A temp table to carry the plaintext passwords out to the final SELECT; the
-- auth table only ever sees the bcrypt hash.
create temp table _new_logins (email text, password text) on commit preserve rows;

do $$
declare
  r record;
  words text[] := array['cobalt','ember','harbor','indigo','jasper','kestrel','lumen',
                        'marble','nimbus','onyx','pyrite','quartz','raven','saffron',
                        'timber','umber','verde','willow','xenon','yarrow','zephyr',
                        'amber','basalt','cedar','dune','flint','garnet','helix'];
  pw text;
  uid uuid;
  n int := 0;
begin
  for r in
    select id, email, name from public.profiles
    where coalesce(email,'') <> ''
    order by name
  loop
    -- Skip anyone who already has a login (linked, or an auth row for the email).
    if (r.id is not null and exists (select 1 from auth.users u where u.id = r.id))
       or exists (select 1 from auth.users u where lower(u.email) = lower(r.email))
       or exists (select 1 from public.profiles p where p.id = r.id and p.auth_id is not null)
    then
      continue;
    end if;

    n := n + 1;
    -- Readable password: Eb-<word>-<4 digits>. Deterministic randomness from a
    -- hash of the email + a per-run salt, so no Math.random is needed and two
    -- people never collide.
    pw := 'Eb-' || words[1 + (('x' || substr(md5(r.email || 'salt10aug'), 1, 4))::bit(16)::int % array_length(words,1))]
              || '-' || lpad(((('x' || substr(md5(r.email || 'pin'), 1, 6))::bit(24)::int) % 9000 + 1000)::text, 4, '0');

    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      lower(r.email), crypt(pw, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', r.name), false
    );

    -- GoTrue needs an identities row for email/password sign-in to work.
    -- auth.identities.email is a GENERATED column in Supabase (derived from
    -- identity_data->>'email'), so it is not written directly.
    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      uid, uid,
      jsonb_build_object('sub', uid::text, 'email', lower(r.email), 'email_verified', true),
      'email', now(), now(), now()
    );

    -- Link the roster entry to this login.
    update public.profiles set auth_id = uid where id = r.id;

    insert into _new_logins (email, password) values (lower(r.email), pw);
  end loop;

  raise notice 'Created % new login(s).', n;
end $$;

-- ── The list to hand out ───────────────────────────────────────────────────
-- New logins show their password. People who already had one show
-- "(already had a login)" — reset from the app if needed.
select p.name,
       lower(p.email)                                   as email,
       coalesce(nl.password, '(already had a login)')   as password,
       p.role                                           as login_type,
       p.dept                                           as department
from public.profiles p
left join _new_logins nl on nl.email = lower(p.email)
where coalesce(p.email,'') <> ''
order by (nl.password is null), p.dept, p.name;

-- Tidy up the temp table (harmless if the session already dropped it).
drop table if exists _new_logins;
