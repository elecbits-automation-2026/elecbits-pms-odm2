-- ═══════════════════════════════════════════════════════════════════════════
-- Create all Elecbits team members as Supabase Auth users + profiles.
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).
-- Prereqs: supabase/schema.sql, then supabase/fix-resource-creation.sql.
--
-- Every account is email-confirmed with the same password below, so people can
-- sign in immediately and change it later. Re-running is safe: existing logins
-- are left alone, and anybody a PM already added in Resources KEEPS their
-- roster row — this script just hands them their login. It never creates a
-- second row for the same person.
-- ═══════════════════════════════════════════════════════════════════════════

-- Defensive: if fix-resource-creation.sql has not run yet, at least the column
-- exists so this script can record the login it creates.
alter table public.profiles add column if not exists auth_id uuid;

do $$
declare
  rec record;
  uid uuid;
  pid uuid;
  pw  text := 'Elecbits@2026';   -- change this if you like
begin
  for rec in
    select * from (values
      ('shreya@elecbits.in','Shreya','superadmin','Dept Head — Project Management'),
      ('saurav@elecbits.in','Saurav','superadmin','Dept Head — Project Management'),
      ('nikhil@elecbits.in','Nikhil','superadmin','Dept Head — Solution Architecture'),
      ('jerom.johnshibu@elecbits.in','Jerom Johnshibu','pm','Jr. Project Manager'),
      ('chhavi.bhatia@elecbits.in','Chhavi Bhatia','pm','Jr. Project Manager'),
      ('gargi.sharma@elecbits.in','Gargi Sharma','pm','Jr. Project Manager'),
      ('nived.p@elecbits.in','Nived P','pm','Jr. Project Manager'),
      ('anunay.dixit@elecbits.in','Anunay Dixit','pm','Sr. Project Manager'),
      ('axs@elecbits.in','AXS','pm','Sr. Hardware Engineer'),
      ('rahul.singh@elecbits.in','Rahul Singh','engineer','Jr. Hardware Engineer'),
      ('yogesh@elecbits.in','Yogesh','engineer','Jr. Hardware Engineer'),
      ('ankit.ashokmishra@elecbits.in','Ankit Ashok Mishra','engineer','Jr. Hardware Engineer'),
      ('jeena.george@elecbits.in','Jeena George','engineer','Jr. Hardware Engineer'),
      ('arun.mohan@elecbits.in','Arun Mohan','engineer','Sr. Hardware Engineer'),
      ('amitabh.gogoi@elecbits.in','Amitabh Gogoi','engineer','Sr. Firmware Engineer'),
      ('aneesh.madhavan@elecbits.in','Aneesh Madhavan','engineer','Jr. Firmware Engineer'),
      ('vishnu.vardhan@elecbits.in','Vishnu Vardhan','engineer','Jr. Firmware Engineer'),
      ('swati.saxena@elecbits.in','Swati Saxena','engineer','Jr. Firmware Engineer'),
      ('sonu.kumar@elecbits.in','Sonu Kumar','engineer','Jr. Firmware Engineer'),
      ('sai.kiran@elecbits.in','Sai Kiran','engineer','Jr. Firmware Engineer'),
      ('israfil.khan@elecbits.in','Israfil Khan','engineer','Jr. Firmware Engineer'),
      ('sheik.ayesha@elecbits.in','Ayesha Sheik','engineer','Jr. Firmware Engineer'),
      ('nethravathi.gk@elecbits.in','Nethravathi GK','engineer','Jr. Firmware Engineer'),
      ('harshal.vaishampayan@elecbits.in','Harshal Vaishampayan','engineer','Supply Chain'),
      ('anwer.suhail@elecbits.in','Anwer Suhail','engineer','Industrial Designer')
    ) as t(email, name, role, title)
  loop
    select id into uid from auth.users where email = rec.email;

    if uid is null then
      uid := gen_random_uuid();

      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', rec.email,
        crypt(pw, gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('name', rec.name),
        '', '', '', ''
      );

      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), uid, rec.email,
        jsonb_build_object('sub', uid::text, 'email', rec.email, 'email_verified', true),
        'email', now(), now(), now()
      );
    end if;

    -- Find the person on the roster, in order of confidence: the login we just
    -- made or found, then their email, then the old convention where the
    -- roster id and the auth id were the same thing. A resource a PM added by
    -- hand is matched on email — keeping THEIR row, and everything filled in
    -- on it, rather than adding a second one.
    select id into pid from public.profiles
     where auth_id = uid
        or (email is not null and lower(email) = lower(rec.email))
        or id = uid
     order by (auth_id = uid) desc,
              (email is not null and lower(email) = lower(rec.email)) desc
     limit 1;

    if pid is null then
      insert into public.profiles (id, auth_id, email, name, role, title, color)
      values (uid, uid, rec.email, rec.name, rec.role, rec.title, '#2563eb');
    else
      update public.profiles
         set auth_id = uid, email = rec.email, name = rec.name,
             role = rec.role, title = rec.title
       where id = pid;
    end if;
  end loop;
end $$;

-- Verify. Everyone should have a login; "awaiting sign-up" here means the
-- roster row never got matched to an account.
select
  email, role, title,
  case when auth_id is null then 'awaiting sign-up' else 'can sign in' end as login
from public.profiles
order by role, email;
