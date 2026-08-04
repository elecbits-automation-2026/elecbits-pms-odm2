-- ═══════════════════════════════════════════════════════════════════════════
-- Create all Elecbits team members as Supabase Auth users + profiles.
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).
-- Prereq: run supabase/schema.sql first (creates profiles + pgcrypto).
--
-- Every account is email-confirmed with the same password below, so people can
-- sign in immediately and change it later. Re-running is safe (existing users
-- are skipped; profiles are re-applied).
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  rec record;
  uid uuid;
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

    -- ensure the profile carries the right role/title (trigger may have made a default one)
    insert into public.profiles (id, email, name, role, title, color)
    values (uid, rec.email, rec.name, rec.role, rec.title, '#2563eb')
    on conflict (id) do update
      set role = excluded.role, title = excluded.title, name = excluded.name, email = excluded.email;
  end loop;
end $$;

-- Verify
select email, role, title from public.profiles order by role, email;
