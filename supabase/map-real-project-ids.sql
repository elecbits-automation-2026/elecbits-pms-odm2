-- ═══════════════════════════════════════════════════════════════════════════
-- MAP THE REAL PROJECT IDS — from the master sheet, 10 Aug 2026.
--
-- For each of the 12 projects this UPDATES IN PLACE whatever already exists —
-- matched by real ID, by the placeholder ID from the earlier load (EB-SA-50…),
-- or by name — setting the real Eb- Project ID, the PCB/GW IDs as linked IDs,
-- the timeline and the team, while PRESERVING everything the project has
-- already accumulated (chat, plan, Drive learning, brainstorming, tasks keep
-- working because the app id of the project does not change).
--
-- FMS - 200 units IS the existing Eb-09-ML-432-01-1752 — it is renamed and
-- retimed, never duplicated. Projects not present at all are inserted.
-- Idempotent: a second run finds everything by its real ID and changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. George and Syed, if the roster script has not added them ────────────
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

-- ── 1. The mapping ─────────────────────────────────────────────────────────
do $$
declare
  spec record;
  blob jsonb;
  projects jsonb;
  proj jsonb;
  idx int;
  team jsonb;
  member record;
  linked jsonb;
  l jsonb;
  found int;
  pid text;
  saurav text;
  missing text := '';
  updated int := 0; inserted int := 0;
begin
  select id::text into saurav from public.profiles where lower(name) like 'saurav%' limit 1;
  select coalesce(value::jsonb, '{"projects":[],"clients":[],"notes":[],"tasks":[]}'::jsonb)
    into blob from public.app_kv where key = 'pms-v1-a';
  if blob is null then blob := '{"projects":[],"clients":[],"notes":[],"tasks":[]}'::jsonb; end if;
  projects := coalesce(blob->'projects', '[]'::jsonb);

  for spec in
    select * from (values
      ('Eb-21-EL-287-01-1809', 'EB-SA-50',      'Smart Adapter - 50 units',            'Schneider Electric', '2026-02-01', '2026-08-24',
        '["ES3C3-BL09-LK306-TC2030-GW-119"]'::jsonb,
        '[["PM (Project Manager)","chhavi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","ayesha"],["Tester / QA","george"]]'::jsonb),
      ('Eb-21-EL-287-01-1825', 'EB-SA-MP',      'Smart Adapter - Mass Production',     'Schneider Electric', '2026-07-01', '2026-10-16',
        '[]'::jsonb,
        '[["PM (Project Manager)","chhavi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","ayesha"],["Tester / QA","george"]]'::jsonb),
      ('Eb-21-EL-287-01-1628', 'EB-EVSO',       'EVSO Outdoor',                        'Schneider Electric', '2026-02-01', '2026-10-16',
        '["Eb-21-EL-287-01-1628-GW-109"]'::jsonb,
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('Eb-21-EL-287-01-1629', 'EB-PROCONNECT', 'Proconnect',                          'Schneider Electric', '2026-02-01', '2026-10-16',
        '["Eb-21-EL-287-01-1629-GW-110"]'::jsonb,
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","vishnu"],["Tester / QA","george"]]'::jsonb),
      ('Eb-21-EL-287-01-1579', 'EB-REPEATER',   'Repeater',                            'Schneider Electric', '2026-04-01', '2026-10-16',
        '["Eb-21-EL-287-01-1579-GW-108"]'::jsonb,
        '[["PM (Project Manager)","gargi"],["Senior PM (Technical Manager)","akshay"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","ankit"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('Eb-04-EL-346-01-1347', 'EB-SLC',        'Street Lighting Controller (SLC)',    'Jio',                '2026-06-08', '2026-08-31',
        '["ES3C3-JNIC-LS05-RELY5-C1CT5-GW-115"]'::jsonb,
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","reven"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","swati"],["Tester / QA","george"]]'::jsonb),
      ('Eb-04-EL-346-01-1472', 'EB-DCU-12V',    'Driver Controller Unit (DCU) - 12V',  'Jio',                '2026-06-08', '2026-08-31',
        '["ES3C3-JNIC-LM25-C1CT5-GW-116"]'::jsonb,
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","shivender"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('Eb-04-EL-346-01-1770', 'EB-DCU-5V',     'Mini Driver Controller Unit (DCU) - 5V','Jio',              '2026-06-08', '2026-08-31',
        '["ES3C3-JNIC-C1CT5-5V-GW-117"]'::jsonb,
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","shivender"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","aneesh"],["Tester / QA","george"]]'::jsonb),
      ('Eb-09-ML-432-01-1630', 'EB-FMS-25',     'FMS - 25 units',                      'Nevon/JSW',          '2026-06-01', '2026-08-31',
        '["Eb-09-ML-432-01-1630-IMX-GW-113","Eb-09-ML-432-01-1630-N58-GW-114"]'::jsonb,
        '[["PM (Project Manager)","jerom"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","arvind"],["Sr. Firmware Engineer","sonu"],["Jr. Firmware Engineer","israfil"],["Tester / QA","george"]]'::jsonb),
      ('Eb-09-ML-432-01-1752', 'EB-FMS-200',    'FMS - 200 units',                     'Nevon/JSW',          '2026-07-01', '2026-09-30',
        '["Eb-09-ML-432-01-1630-IMX-200U-GW-120","Eb-09-ML-432-01-1630-N58-200U-GW-121"]'::jsonb,
        '[["PM (Project Manager)","jerom"],["Sr. Hardware Engineer","arun"],["Jr. Hardware Engineer","rahul"],["Jr. Hardware Engineer","arvind"],["Sr. Firmware Engineer","sonu"],["Jr. Firmware Engineer","israfil"],["Tester / QA","george"]]'::jsonb),
      ('EbX-RD-01-01-1655',    'EB-WIFI-CAM',   'WiFi Camera',                         'Internal',           '2026-07-16', '2026-08-31',
        '["EbX-RD-01-01-1655-GW-111"]'::jsonb,
        '[["PM (Project Manager)","harshal"],["Sr. Hardware Engineer","ankit"],["Jr. Hardware Engineer","jeena"],["Sr. Firmware Engineer","sai"],["Jr. Firmware Engineer","nethravathi"],["Tester / QA","george"]]'::jsonb),
      ('EbX-RD-01-00-01-1800', 'EB-GPS',        'GPS',                                 'Internal',           '2026-07-13', '2026-08-31',
        '["EbX-RD-01-00-01-1800-GW-122"]'::jsonb,
        '[["PM (Project Manager)","chhavi"],["Sr. Hardware Engineer","syed"],["Sr. Firmware Engineer","syed"],["Tester / QA","george"]]'::jsonb)
    ) as t(real_id, old_id, name, client, start_date, end_date, gw_ids, members)
  loop
    -- resolve the team for this project
    team := '[]'::jsonb;
    for member in select m->>0 as slot, m->>1 as key from jsonb_array_elements(spec.members) m loop
      select id::text into pid from public.profiles
      where role is distinct from 'superadmin'
        and (lower(name) like member.key || '%' or lower(name) like '% ' || member.key || '%'
             or lower(coalesce(email,'')) like member.key || '%')
      order by created_at nulls last limit 1;
      if pid is null then
        missing := missing || spec.real_id || ': no roster match for "' || member.key || '"' || E'\n';
      else
        team := team || jsonb_build_array(jsonb_build_object('slot', member.slot, 'userId', pid));
      end if;
    end loop;

    -- Find EVERY entry this spec could mean: the real ID, the placeholder
    -- from the earlier load, or the name. More than one can exist at once —
    -- the original 1752 AND a placeholder "FMS - 200 units" — and mapping
    -- only one of them would mint a duplicate project ID. The one with the
    -- real ID (or, failing that, the most accumulated history) is kept and
    -- patched; the others are absorbed into it and removed.
    declare
      matches int[] := '{}';
      primary_idx int := -1;
      rest jsonb;
      weight int; best int := -1;
    begin
      for idx in 0 .. jsonb_array_length(projects) - 1 loop
        proj := projects->idx;
        if proj->>'projectId' = spec.real_id
           or proj->>'projectId' = spec.old_id
           or lower(coalesce(proj->>'name','')) = lower(spec.name) then
          matches := matches || idx;
        end if;
      end loop;

      if array_length(matches, 1) is null then
        -- nothing anywhere: brand new
        projects := jsonb_build_array(jsonb_build_object(
          'id', 'pr-' || substr(md5(spec.real_id), 1, 8),
          'projectId', spec.real_id, 'idMode', 'manual', 'origin', 'existing',
          'name', spec.name, 'clientName', spec.client, 'clientId', '', 'industry', '', 'orgSize', '',
          'contact', '{}'::jsonb, 'linkedIds', spec.gw_ids, 'team', team,
          'startDate', spec.start_date, 'deadline', spec.end_date, 'status', 'In Progress',
          'knownStatus', '', 'lldCustomer', null, 'lldDesigner', null,
          'intelligence', '[]'::jsonb, 'chat', '[]'::jsonb, 'driveLearning', null,
          'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'createdBy', coalesce(saurav, '')
        )) || projects;
        inserted := inserted + 1;
      else
        -- pick the keeper: the real-ID entry, else the one with the most history
        foreach idx in array matches loop
          proj := projects->idx;
          if proj->>'projectId' = spec.real_id then primary_idx := idx; exit; end if;
          weight := jsonb_array_length(coalesce(proj->'chat','[]'::jsonb))
                  + jsonb_array_length(coalesce(proj->'intelligence','[]'::jsonb))
                  + jsonb_array_length(coalesce(proj->'moms','[]'::jsonb))
                  + case when coalesce(proj->>'driveLearning','') <> '' then 5 else 0 end
                  + case when coalesce(proj->>'knownStatus','') <> '' then 1 else 0 end;
          if weight > best then best := weight; primary_idx := idx; end if;
        end loop;

        -- union of GW ids: the sheet's, the keeper's, and the absorbed ones'
        linked := spec.gw_ids;
        foreach idx in array matches loop
          for l in select * from jsonb_array_elements(coalesce(projects->idx->'linkedIds','[]'::jsonb)) loop
            if not (linked ? (l#>>'{}')) then linked := linked || jsonb_build_array(l); end if;
          end loop;
        end loop;

        -- rebuild: patch the keeper, drop the duplicates
        rest := '[]'::jsonb;
        for idx in 0 .. jsonb_array_length(projects) - 1 loop
          if idx = primary_idx then
            rest := rest || jsonb_build_array((projects->idx) || jsonb_build_object(
              'projectId', spec.real_id, 'idMode', 'manual',
              'name', spec.name, 'clientName', spec.client,
              'startDate', spec.start_date, 'deadline', spec.end_date,
              'status', 'In Progress', 'team', team, 'linkedIds', linked
            ));
          elsif idx = any(matches) then
            null;  -- absorbed duplicate
          else
            rest := rest || jsonb_build_array(projects->idx);
          end if;
        end loop;
        projects := rest;
        updated := updated + 1;
      end if;
    end;
  end loop;

  blob := jsonb_set(blob, '{projects}', projects);
  insert into public.app_kv (key, value, updated_at)
  values ('pms-v1-a', blob::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  -- the mirror table: retire placeholder rows so only real IDs remain
  delete from public.projects where project_id in
    ('EB-SA-50','EB-SA-MP','EB-EVSO','EB-PROCONNECT','EB-REPEATER','EB-SLC',
     'EB-DCU-12V','EB-DCU-5V','EB-FMS-25','EB-FMS-200','EB-WIFI-CAM','EB-GPS');

  raise notice 'Updated % project(s), inserted % project(s).', updated, inserted;
  if missing <> '' then raise warning E'UNRESOLVED PEOPLE:\n%', missing; end if;
end $$;

-- ── 2. The result ──────────────────────────────────────────────────────────
select p->>'projectId'  as project_id,
       p->>'name'       as project,
       p->>'clientName' as client,
       p->>'startDate'  as starts,
       p->>'deadline'   as ends,
       jsonb_array_length(coalesce(p->'team','[]'::jsonb))      as team,
       jsonb_array_length(coalesce(p->'linkedIds','[]'::jsonb)) as gw_ids
from public.app_kv, jsonb_array_elements(value::jsonb->'projects') p
where key = 'pms-v1-a'
order by p->>'startDate';
