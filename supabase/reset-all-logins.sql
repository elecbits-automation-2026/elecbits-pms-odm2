-- ═══════════════════════════════════════════════════════════════════════════
-- SET A PASSWORD FOR EVERYONE — including people who already have a login.
--
-- Passwords cannot be read back from Supabase (only a bcrypt hash is kept), so
-- "give me everyone's password" means: set a fresh, known password for every
-- person on the roster and print the full list. This does exactly that.
--
--   • No login yet   → creates the account (email-confirmed, ready to use).
--   • Already has one → RESETS its password to the new one below.
--
-- This includes your own admin account. That is safe: your current browser
-- session keeps working; you simply sign in with the new password next time.
-- If you would rather NOT touch accounts that already exist, use
-- create-all-logins.sql instead — that one only fills in the missing ones.
--
-- Passwords are readable: "Eb-<word>-<4 digits>". They appear ONCE, in the
-- result below — copy it out and store it safely; it cannot be reprinted.
-- Idempotent in effect: re-running just sets the same deterministic passwords
-- again.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;
create temp table _all_logins (name text, email text, password text, kind text) on commit preserve rows;

do $$
declare
  r record;
  words text[] := array['cobalt','ember','harbor','indigo','jasper','kestrel','lumen',
                        'marble','nimbus','onyx','pyrite','quartz','raven','saffron',
                        'timber','umber','verde','willow','xenon','yarrow','zephyr',
                        'amber','basalt','cedar','dune','flint','garnet','helix'];
  pw text;
  uid uuid;
  created int := 0; reset int := 0;
begin
  for r in
    select id, email, name from public.profiles
    where coalesce(email,'') <> ''
    order by name
  loop
    -- The deterministic, readable password for this person.
    pw := 'Eb-' || words[1 + (('x' || substr(md5(r.email || 'salt10aug'), 1, 4))::bit(16)::int % array_length(words,1))]
              || '-' || lpad(((('x' || substr(md5(r.email || 'pin'), 1, 6))::bit(24)::int) % 9000 + 1000)::text, 4, '0');

    -- Is there already an auth account? Match by the roster's linked id, by the
    -- profile id, or by email.
    select u.id into uid
    from auth.users u
    where u.id = coalesce((select auth_id from public.profiles p where p.id = r.id), '00000000-0000-0000-0000-000000000000'::uuid)
       or u.id = r.id
       or lower(u.email) = lower(r.email)
    limit 1;

    if uid is not null then
      -- RESET the existing account's password and make sure it is usable.
      update auth.users set
        encrypted_password = crypt(pw, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
      where id = uid;
      -- ensure an identity row exists (older accounts may lack one)
      if not exists (select 1 from auth.identities where user_id = uid and provider = 'email') then
        insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (uid, uid, jsonb_build_object('sub', uid::text, 'email', lower(r.email), 'email_verified', true),
                'email', now(), now(), now());
      end if;
      update public.profiles set auth_id = uid where id = r.id and auth_id is distinct from uid;
      insert into _all_logins values (r.name, lower(r.email), pw, 'reset');
      reset := reset + 1;
    else
      -- CREATE a brand-new account.
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
        lower(r.email), crypt(pw, gen_salt('bf')), now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', r.name), false
      );
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (uid, uid, jsonb_build_object('sub', uid::text, 'email', lower(r.email), 'email_verified', true),
              'email', now(), now(), now());
      update public.profiles set auth_id = uid where id = r.id;
      insert into _all_logins values (r.name, lower(r.email), pw, 'new');
      created := created + 1;
    end if;

    uid := null;  -- reset for the next iteration
  end loop;

  raise notice 'Created % new login(s), reset % existing login(s).', created, reset;
end $$;

-- ── The list to hand out — EVERYONE, with their password ───────────────────
select l.name,
       l.email,
       l.password,
       case l.kind when 'new' then 'new account' else 'password reset' end as status,
       p.role as login_type,
       p.dept as department
from _all_logins l
join public.profiles p on lower(p.email) = l.email
order by p.dept, l.name;

drop table if exists _all_logins;
