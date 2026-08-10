-- ═══════════════════════════════════════════════════════════════════════════
-- ADD THE 12 PROJECTS — timelines and teams, from Saurav's sheet (10 Aug 2026).
--
-- Writes into the workspace store (`app_kv`), which is what the app reads, so
-- the projects appear in every open browser within ~30 seconds via the sync.
-- Team members are resolved to real roster people by name; George (Tester)
-- and Syed are added to the roster first since they were not on it.
--
-- Dates from the sheet are D/M/YYYY. Every project has started and none has
-- ended, so all land as "In Progress".
--
-- Idempotent: projects whose ID already exists in the workspace are skipped,
-- so a second run changes nothing and never duplicates.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. The two people the sheet needs who are not on the roster ────────────
do $$
begin
  if not exists (select 1 from public.profiles where lower(name) like 'george%' or lower(coalesce(email,'')) like 'george%') then
    insert into public.profiles (id, name, email, role, title, resource_role, dept, skills, project_tags, max_projects, color)
    values (gen_random_uuid(), 'George', 'george@elecbits.in', 'engineer', 'Tester / QA', 'tester', 'Testing',
            '["Test Planning","Functional Testing","Test Reports","Compliance Pre-checks"]', '["engineering"]', 6, '#0d9488');
  end if;
  if not exists (select 1 from public.profiles where lower(name) like 'syed%' or lower(coalesce(email,'')) like 'syed%') then
    insert into public.profiles (id, name, email, role, title, resource_role, dept, skills, project_tags, max_projects, color)
    values (gen_random_uuid(), 'Syed', 'syed@elecbits.in', 'engineer', 'Sr. Hardware Engineer', 'sr_hw', 'Hardware',
            '["PCB Designing","Schematic Design","Hardware Debugging","Embedded C"]', '["engineering"]', 6, '#b45309');
  end if;
end $$;

-- ── 1. The projects ────────────────────────────────────────────────────────

do $$
declare
  spec record;
  blob jsonb;
  existing jsonb;
  have text[];
  team jsonb;
  member record;
  new_projects jsonb := '[]'::jsonb;
  added int := 0;
  saurav text;
  missing text := '';
  pid text;
begin
  select id::text into saurav from public.profiles where lower(name) like 'saurav%' limit 1;

  select coalesce(value::jsonb, '{"projects":[],"clients":[],"notes":[],"tasks":[]}'::jsonb)
    into blob from public.app_kv where key = 'pms-v1-a';
  if blob is null then blob := '{"projects":[],"clients":[],"notes":[],"tasks":[]}'::jsonb; end if;
  existing := coalesce(blob->'projects', '[]'::jsonb);
  select coalesce(array_agg(p->>'projectId'), '{}') into have from jsonb_array_elements(existing) p;

  for spec in
    select * from (values
      ('EB-SA-50',      'Smart Adapter - 50 units',        'Schneider Electric', '2026-02-01', '2026-08-24',
        '[["PM (Project Manager)","chhavi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","ayesha"],["Tester / QA","george"]]'::jsonb),
      ('EB-SA-MP',      'Smart Adapter - Mass Production', 'Schneider Electric', '2026-07-01', '2026-10-16',
        '[["PM (Project Manager)","chhavi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","ayesha"],["Tester / QA","george"]]'::jsonb),
      ('EB-EVSO',       'EVSO Outdoor',                    'Schneider Electric', '2026-02-01', '2026-10-16',
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('EB-PROCONNECT', 'Proconnect',                      'Schneider Electric', '2026-02-01', '2026-10-16',
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","vishnu"],["Tester / QA","george"]]'::jsonb),
      ('EB-REPEATER',   'Repeater',                        'Schneider Electric', '2026-04-01', '2026-10-16',
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('EB-SLC',        'Street Lighting Controller (SLC)','Jio',                '2026-06-08', '2026-08-31',
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","reven"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","swati"],["Tester / QA","george"]]'::jsonb),
      ('EB-DCU-12V',    'Driver Controller Unit (DCU) - 12V','Jio',              '2026-06-08', '2026-08-31',
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","shivender"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('EB-DCU-5V',     'Mini Driver Controller Unit (DCU) - 5V','Jio',          '2026-06-08', '2026-08-31',
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","shivender"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('EB-FMS-25',     'FMS - 25 units',                  'Nevon/JSW',          '2026-06-01', '2026-08-31',
        '[["PM (Project Manager)","jerom"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","arvind"],["Sr. Firmware Engineer","sonu"],["Jr. Firmware Engineer","israfil"],["Tester / QA","george"]]'::jsonb),
      ('EB-FMS-200',    'FMS - 200 units',                 'Nevon/JSW',          '2026-07-01', '2026-09-30',
        '[["PM (Project Manager)","jerom"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","arvind"],["Sr. Firmware Engineer","sonu"],["Jr. Firmware Engineer","israfil"],["Tester / QA","george"]]'::jsonb),
      ('EB-WIFI-CAM',   'WiFi Camera',                     'Internal',           '2026-07-16', '2026-08-31',
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","ankit"],["Jr. Hardware Engineer","jeena"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","nethravathi"],["Tester / QA","george"]]'::jsonb),
      ('EB-GPS',        'GPS',                             'Internal',           '2026-07-13', '2026-08-31',
        '[["PM (Project Manager)","chhavi"],["Sr. Hardware Engineer","syed"],["Sr. Firmware Engineer","syed"],["Tester / QA","george"]]'::jsonb)
    ) as t(project_id, name, client, start_date, end_date, members)
  loop
    if spec.project_id = any(have) then continue; end if;

    team := '[]'::jsonb;
    for member in select m->>0 as slot, m->>1 as key from jsonb_array_elements(spec.members) m loop
      select id::text into pid from public.profiles
      where role is distinct from 'superadmin'
        and (lower(name) like member.key || '%' or lower(name) like '% ' || member.key || '%'
             or lower(coalesce(email,'')) like member.key || '%')
      order by created_at nulls last limit 1;
      if pid is null then
        missing := missing || spec.project_id || ': no roster match for "' || member.key || '" (' || member.slot || E')\n';
      else
        team := team || jsonb_build_array(jsonb_build_object('slot', member.slot, 'userId', pid));
      end if;
    end loop;

    new_projects := new_projects || jsonb_build_array(jsonb_build_object(
      'id', 'pr-' || substr(md5(spec.project_id), 1, 8),
      'projectId', spec.project_id, 'idMode', 'manual', 'origin', 'existing',
      'name', spec.name, 'clientName', spec.client, 'clientId', '', 'industry', '', 'orgSize', '',
      'contact', '{}'::jsonb, 'linkedIds', '[]'::jsonb, 'team', team,
      'startDate', spec.start_date, 'deadline', spec.end_date, 'status', 'In Progress',
      'knownStatus', '', 'lldCustomer', null, 'lldDesigner', null,
      'intelligence', '[]'::jsonb, 'chat', '[]'::jsonb, 'driveLearning', null,
      'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'createdBy', coalesce(saurav, '')
    ));
    added := added + 1;
  end loop;

  blob := jsonb_set(blob, '{projects}', new_projects || existing);
  insert into public.app_kv (key, value, updated_at)
  values ('pms-v1-a', blob::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  raise notice 'Added % project(s).', added;
  if missing <> '' then raise warning E'UNRESOLVED PEOPLE — fix these on the roster, then re-run:\n%', missing; end if;
end $$;

-- ── 2. What the workspace now holds ────────────────────────────────────────
select p->>'projectId'  as id,
       p->>'name'       as project,
       p->>'clientName' as client,
       p->>'startDate'  as starts,
       p->>'deadline'   as ends,
       jsonb_array_length(coalesce(p->'team', '[]'::jsonb)) as team_size
from public.app_kv, jsonb_array_elements(value::jsonb->'projects') p
where key = 'pms-v1-a'
order by p->>'startDate';
