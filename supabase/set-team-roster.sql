-- ═══════════════════════════════════════════════════════════════════════════
-- SET THE TEAM ROSTER — 10 Aug 2026, as specified by Saurav.
--
--   Project Management · Junior PM · login "Project Manager":
--     Harshal, Ankita, Gargi, Shubhangini, Akshay, Chhavi, Jerom
--   Hardware · Junior Hardware · login "Developer":
--     Rahul, Jeena, Ankit, Yogesh, Shivender, Arvind, Reven, Atharv, Arun
--   Firmware · Junior Firmware · login "Developer":
--     Sai, Sonu, Aneesh M, Israfil, Nethravathi G K, Sheik Ayesha,
--     Vishnu Vardhan, Swati Saxena
--
-- For each person: if a profile already matches their name (or email), it is
-- UPDATED to this department/role/login and keeps its id, email, colour and
-- any attached login. Only people with no match are INSERTED — their emails
-- follow the roster's existing convention (single name → name@elecbits.in,
-- full name → first.last@elecbits.in) and are marked in the report below so
-- wrong guesses can be corrected before anyone tries to sign up.
--
-- Nobody is removed, and superadmins are never touched. Idempotent: a second
-- run changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists auth_id uuid;  -- no-op if migrated

do $$
declare
  spec record;
  hit  int;
  palette text[] := array['#2563eb','#7c3aed','#ea580c','#0891b2','#16a34a','#d97706',
                          '#db2777','#0d9488','#9333ea','#dc2626','#4f46e5','#0284c7'];
  n int := 0;
  pm_skills jsonb := '["Task Tracking","Standups & Scrum","Client Updates","Documentation"]';
  hw_skills jsonb := '["PCB Designing","Schematic Design","Altium Designer","KiCad","Hardware Debugging","Component Selection"]';
  fw_skills jsonb := '["Embedded C","Arduino/ESP32","Peripheral Drivers","Debugging","Unit Testing"]';
begin
  for spec in
    select * from (values
      -- match_key         full_name (if inserting)   email (if inserting)                 role       rr       dept
      ('harshal',      'Harshal',                 'harshal@elecbits.in',                'pm',       'jr_pm', 'Project Management'),
      ('ankita',       'Ankita',                  'ankita@elecbits.in',                 'pm',       'jr_pm', 'Project Management'),
      ('gargi',        'Gargi',                   'gargi@elecbits.in',                  'pm',       'jr_pm', 'Project Management'),
      ('shubhangini',  'Shubhangini',             'shubhangini@elecbits.in',            'pm',       'jr_pm', 'Project Management'),
      ('akshay',       'Akshay',                  'akshay@elecbits.in',                 'pm',       'jr_pm', 'Project Management'),
      ('chhavi',       'Chhavi',                  'chhavi@elecbits.in',                 'pm',       'jr_pm', 'Project Management'),
      ('jerom',        'Jerom',                   'jerom@elecbits.in',                  'pm',       'jr_pm', 'Project Management'),
      ('rahul',        'Rahul',                   'rahul@elecbits.in',                  'engineer', 'jr_hw', 'Hardware'),
      ('jeena',        'Jeena',                   'jeena@elecbits.in',                  'engineer', 'jr_hw', 'Hardware'),
      ('ankit',        'Ankit',                   'ankit@elecbits.in',                  'engineer', 'jr_hw', 'Hardware'),
      ('yogesh',       'Yogesh',                  'yogesh@elecbits.in',                 'engineer', 'jr_hw', 'Hardware'),
      ('shivender',    'Shivender',               'shivender@elecbits.in',              'engineer', 'jr_hw', 'Hardware'),
      ('arvind',       'Arvind',                  'arvind@elecbits.in',                 'engineer', 'jr_hw', 'Hardware'),
      ('reven',        'Reven',                   'reven@elecbits.in',                  'engineer', 'jr_hw', 'Hardware'),
      ('atharv',       'Atharv',                  'atharv@elecbits.in',                 'engineer', 'jr_hw', 'Hardware'),
      ('arun',         'Arun',                    'arun@elecbits.in',                   'engineer', 'jr_hw', 'Hardware'),
      ('sai',          'Sai',                     'sai@elecbits.in',                    'engineer', 'jr_fw', 'Firmware'),
      ('sonu',         'Sonu',                    'sonu@elecbits.in',                   'engineer', 'jr_fw', 'Firmware'),
      ('aneesh',       'Aneesh M',                'aneesh.m@elecbits.in',               'engineer', 'jr_fw', 'Firmware'),
      ('israfil',      'Israfil',                 'israfil@elecbits.in',                'engineer', 'jr_fw', 'Firmware'),
      ('nethravathi',  'Nethravathi G K',         'nethravathi.gk@elecbits.in',         'engineer', 'jr_fw', 'Firmware'),
      ('ayesha',       'Sheik Ayesha',            'sheik.ayesha@elecbits.in',           'engineer', 'jr_fw', 'Firmware'),
      ('vishnu',       'Vishnu Vardhan',          'vishnu.vardhan@elecbits.in',         'engineer', 'jr_fw', 'Firmware'),
      ('swati',        'Swati Saxena',            'swati.saxena@elecbits.in',           'engineer', 'jr_fw', 'Firmware')
    ) as t(match_key, full_name, email, role, rr, dept)
  loop
    n := n + 1;
    -- Match anywhere in the name (word-start) or in the email, never a superadmin.
    update public.profiles p set
      role          = spec.role,
      resource_role = spec.rr,
      dept          = spec.dept,
      title         = case spec.rr when 'jr_pm' then 'Jr. Project Manager'
                                   when 'jr_hw' then 'Jr. Hardware Engineer'
                                   else 'Jr. Firmware Engineer' end,
      skills        = case spec.rr when 'jr_pm' then pm_skills
                                   when 'jr_hw' then hw_skills else fw_skills end,
      project_tags  = coalesce(p.project_tags, '["engineering"]'::jsonb),
      max_projects  = coalesce(p.max_projects, 3)
    where p.role is distinct from 'superadmin'
      and (lower(p.name) like spec.match_key || '%'
           or lower(p.name) like '% ' || spec.match_key || '%'
           or lower(coalesce(p.email, '')) like spec.match_key || '%'
           or lower(coalesce(p.email, '')) like '%.' || spec.match_key || '@%');
    get diagnostics hit = row_count;

    if hit = 0 then
      insert into public.profiles (id, name, email, role, title, resource_role, dept,
                                   skills, project_tags, max_projects, color)
      values (gen_random_uuid(), spec.full_name, spec.email, spec.role,
              case spec.rr when 'jr_pm' then 'Jr. Project Manager'
                           when 'jr_hw' then 'Jr. Hardware Engineer'
                           else 'Jr. Firmware Engineer' end,
              spec.rr, spec.dept,
              case spec.rr when 'jr_pm' then pm_skills
                           when 'jr_hw' then hw_skills else fw_skills end,
              '["engineering"]'::jsonb, 3, palette[1 + (n % 12)]);
    end if;
  end loop;
end $$;

-- ── The report: who is on the roster now, and who can already sign in ──────
-- "no login yet" means: either set them a password from Add Resource → Edit,
-- or they sign up themselves with EXACTLY this email.
select name, email, role, resource_role as "role/function", dept,
       case when auth_id is not null then 'can sign in' else 'no login yet' end as login
from public.profiles
order by case role when 'superadmin' then 0 when 'pm' then 1 else 2 end, dept, name;
