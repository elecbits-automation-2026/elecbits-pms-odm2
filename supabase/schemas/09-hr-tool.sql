-- ═══════════════════════════════════════════════════════════════════════════
-- 09-hr-tool — what the HR TOOL needs that 07-hr.sql did not have.
--
-- 07-hr.sql modelled the employment record: employees, compensation, time,
-- appraisals, goals, payroll, hiring. It did not model the things an employee
-- actually opens an HR app to do — join, read what is expected of them, be
-- heard, and see where they sit. That is what this adds.
--
-- It also performs the ONE move this tool needs from another schema. The rule
-- in 01-core.sql is that no tool ever reads another tool's schema. The daily
-- work record (kpi_log, work_updates) sat in `pms`, and HR needs it — so it
-- moves to `core` rather than being copied. Everyone in the company writes a
-- daily update; it was never PMS-specific.
--
-- Requires: sanction-gate.sql, 01-core.sql, 07-hr.sql
-- Idempotent: safe to re-run.
--
-- ⚠ ACCESS NOTE — read this before you assume anything is locked down.
-- Decision of 30 Aug 2026 was to keep HR on public.is_admin(), which is
-- role in ('superadmin','dept_head'). On the current roster that is four
-- superadmins plus every department head — all of whom can therefore read
-- hr.compensation and hr.payslips. That is a deliberate, recorded choice, not
-- an oversight. hr.employees.hr_role and hr.is_hr() below exist so tightening
-- it later is a policy swap rather than a migration against live payroll.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 0. THE MOVE — kpi_log and work_updates, pms → core ════════════════════
-- Done with ALTER ... SET SCHEMA so the rows travel with the table. The app
-- reads through src/lib/tables.js, which probes for the new location and
-- falls back to the old one, so the deploy and this migration do not have to
-- land in the same two minutes.

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'pms' and table_name = 'kpi_log')
     and not exists (select 1 from information_schema.tables
                     where table_schema = 'core' and table_name = 'kpi_log') then
    execute 'alter table pms.kpi_log set schema core';
    raise notice 'moved pms.kpi_log → core.kpi_log';
  end if;

  if exists (select 1 from information_schema.tables
             where table_schema = 'pms' and table_name = 'work_updates')
     and not exists (select 1 from information_schema.tables
                     where table_schema = 'core' and table_name = 'work_updates') then
    execute 'alter table pms.work_updates set schema core';
    raise notice 'moved pms.work_updates → core.work_updates';
  end if;
end $$;

-- If the PMS was never installed here, create them so HR has somewhere to
-- write. Same columns the PMS used, so a later PMS install joins cleanly.
create table if not exists core.work_updates (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  user_id     uuid references core.people(id) on delete cascade,
  user_app_id text,
  date        date not null,
  note        text,
  score       int,                       -- NULL means unscored, never 0
  feedback    text,
  kpi_hits    text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists work_updates_user_idx on core.work_updates (user_id, date desc);

create table if not exists core.kpi_log (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  user_id     uuid references core.people(id) on delete cascade,
  user_app_id text,
  date        date not null,
  metrics     jsonb not null default '{}'::jsonb,
  alerts      text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- A kpi_log that MOVED here predates this file: the PMS logs per-PM KPI
-- events keyed `pm_id` (schema.sql, every-table-filled.sql), and has no
-- user_id. The fresh table above has user_id. Index whichever identity
-- column this database actually has — the index name is the same either
-- way, so a re-run skips it.
do $$
declare ident text;
begin
  select column_name into ident
    from information_schema.columns
   where table_schema = 'core' and table_name = 'kpi_log'
     and column_name in ('user_id', 'pm_id')
   order by case column_name when 'user_id' then 0 else 1 end
   limit 1;
  if ident is not null
     and not exists (select 1 from pg_indexes
                     where schemaname = 'core' and indexname = 'kpi_log_user_idx') then
    execute format('create index kpi_log_user_idx on core.kpi_log (%I, date desc)', ident);
  end if;
end $$;

comment on column core.work_updates.score is
  'NULL means the entry was stored but not scored — an AI outage, or scoring '
  'switched off. It must never be written as 0: a backend failure would then '
  'manufacture a damning performance record out of a network blip.';


-- ═══ 1. THE TOOL'S OWN BLOB ════════════════════════════════════════════════
-- Same shape as pms.workspace. The app is blob-authoritative and mirrors out
-- to real rows; this is the blob.

create table if not exists hr.workspace (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);


-- ═══ 2. JOINING — onboarding and the policies you sign ═════════════════════

create table if not exists hr.onboarding_journeys (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  employee_id uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  started_on  date,
  due_on      date,
  status      text not null default 'open' check (status in ('open','done','abandoned')),
  created_at  timestamptz not null default now()
);
create index if not exists hr_journey_emp_idx on hr.onboarding_journeys (employee_id);

create table if not exists hr.onboarding_tasks (
  id          uuid primary key default gen_random_uuid(),
  journey_id  uuid references hr.onboarding_journeys(id) on delete cascade,
  seq         int  not null default 0,
  phase       text,                       -- 'Before you start' | 'Week one' | 'First 30 days'
  task_key    text,
  title       text not null,
  owner       text not null default 'employee'
                check (owner in ('employee','hr','manager','admin')),
  policy_code text,                       -- links a task to hr.policies
  done_at     timestamptz,
  done_by     uuid
);
create index if not exists hr_obtask_journey_idx on hr.onboarding_tasks (journey_id, seq);

create table if not exists hr.policies (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  code        text not null,
  title       text not null,
  version     text not null,
  category    text,
  ack_required boolean not null default false,
  effective_from date,
  drive_id    text,
  summary     text,
  created_at  timestamptz not null default now(),
  unique (code, version)
);

-- One row per (person, policy, VERSION). Versioned on purpose: bumping a
-- policy's version leaves every old signature standing as history and puts
-- the policy back in front of everyone, which is the whole point of tracking
-- acknowledgement at all.
create table if not exists hr.policy_acks (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  policy_code text not null,
  version     text not null,
  employee_id uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  acked_at    timestamptz not null default now(),
  unique (policy_code, version, employee_id)
);
create index if not exists hr_ack_emp_idx on hr.policy_acks (employee_id);


-- ═══ 3. EXPECTATIONS — the ladder and the recognition ══════════════════════

create table if not exists hr.bands (
  code       text primary key,            -- L1 … L6
  name       text not null,
  level      int  not null,
  next_code  text references hr.bands(code),
  expects    text
);

-- An open conversation about the next band. Not a promotion record — the
-- letter for that lands in the employee's Drive folder (Tier 2), per the
-- Drive architecture decision that letters live there and data lives here.
create table if not exists hr.career_tracks (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  employee_id uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  band_code   text references hr.bands(code),
  target_band text references hr.bands(code),
  opened_on   date not null default current_date,
  opened_by   uuid,
  note        text,
  status      text not null default 'open' check (status in ('open','met','closed')),
  closed_at   timestamptz
);
create index if not exists hr_track_emp_idx on hr.career_tracks (employee_id, status);

create table if not exists hr.recognitions (
  id           uuid primary key default gen_random_uuid(),
  app_id       text unique,
  employee_id  uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  award_type   text not null,             -- spot | owner | customer | innov | team
  cycle        text,                      -- 'Aug 2026' | 'Q2 FY26-27'
  citation     text not null,
  value_inr    numeric(12,2),
  nominated_by uuid,
  nominated_by_app_id text,
  approved_by  uuid,
  at           timestamptz not null default now()
);
create index if not exists hr_recog_emp_idx on hr.recognitions (employee_id, at desc);


-- ═══ 4. VOICE — grievances and the open door ═══════════════════════════════
--
-- ⚠ POSH IS NOT MODELLED HERE, DELIBERATELY.
-- Under the Sexual Harassment of Women at Workplace (Prevention, Prohibition
-- and Redressal) Act 2013, ICC proceedings carry statutory confidentiality.
-- A POSH matter written into this table would be readable by everyone
-- public.is_admin() covers — which, per the access note at the top, is every
-- department head. The app routes POSH to the Internal Committee offline and
-- stores nothing. Do not add a 'posh' category to the check below.

create table if not exists hr.grievances (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  case_id     text unique not null,       -- GRV-2026-004, per the Drive key scheme
  raised_by   uuid references hr.employees(id) on delete set null,
  raised_by_app_id text,                  -- NULL for an anonymous case
  anonymous   boolean not null default false,
  category    text check (category is null or category in
                ('pay_benefits','workload','manager_conduct','peer_conduct',
                 'facilities','policy_clarity','career_growth','other')),
  severity    text check (severity is null or severity in ('low','medium','high')),
  summary     text,
  detail      text,
  status      text not null default 'open'
                check (status in ('open','ack','investigating','resolved','closed')),
  owner_id    uuid references hr.employees(id) on delete set null,
  at          timestamptz not null default now(),
  ack_at      timestamptz,
  closed_at   timestamptz
);
create index if not exists hr_grv_status_idx on hr.grievances (status, at desc);

-- Two audiences on one thread. `visible_to_raiser` is what separates an
-- internal note from a reply — posting the first where the second goes is the
-- failure mode this column exists to prevent.
create table if not exists hr.grievance_notes (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  case_id     text not null references hr.grievances(case_id) on delete cascade,
  by_id       uuid,
  by_app_id   text,
  text        text not null,
  visible_to_raiser boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists hr_grvnote_case_idx on hr.grievance_notes (case_id, at);

create table if not exists hr.discussion_slots (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique,
  owner_id   uuid references hr.employees(id) on delete cascade,
  owner_app_id text,
  mode       text not null default 'hr_open_door'
               check (mode in ('hr_open_door','dept_head','skip_level')),
  date       date not null,
  from_time  time not null,
  to_time    time not null,
  capacity   int  not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists hr_slot_date_idx on hr.discussion_slots (date, owner_id);

create table if not exists hr.discussion_bookings (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  slot_id     uuid references hr.discussion_slots(id) on delete cascade,
  slot_app_id text,
  employee_id uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  topic       text,
  anonymous   boolean not null default false,
  status      text not null default 'booked'
                check (status in ('booked','done','cancelled','no_show')),
  at          timestamptz not null default now()
);
create index if not exists hr_booking_slot_idx on hr.discussion_bookings (slot_id);


-- ═══ 5. ORG STRUCTURE — the functional axis ════════════════════════════════
-- The hierarchical axis is hr.employees.manager_id and needs no table. This
-- is the OTHER chart: divisions, departments, and chapters that cut across
-- them. A firmware engineer sits in the Firmware department and the Quality
-- chapter at once, which a reporting line cannot express.

create table if not exists hr.org_units (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique,
  name       text not null,
  kind       text not null default 'department'
               check (kind in ('company','division','department','chapter')),
  parent_id  uuid references hr.org_units(id) on delete set null,
  parent_app_id text,
  head_id    uuid references hr.employees(id) on delete set null,
  head_app_id text,
  created_at timestamptz not null default now()
);
create index if not exists hr_unit_parent_idx on hr.org_units (parent_id);

create table if not exists hr.unit_members (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  employee_id uuid references hr.employees(id) on delete cascade,
  employee_app_id text,
  unit_id     uuid references hr.org_units(id) on delete cascade,
  unit_app_id text,
  role        text,
  is_primary  boolean not null default true
);
create index if not exists hr_unitmem_unit_idx on hr.unit_members (unit_id);
-- One primary home per person; chapter memberships are the extras.
create unique index if not exists hr_unitmem_primary_idx
  on hr.unit_members (employee_id) where is_primary;


-- ═══ 6. HOLIDAYS ═══════════════════════════════════════════════════════════
create table if not exists hr.holidays (
  date       date primary key,
  name       text not null,
  location   text,                        -- null = everywhere
  optional   boolean not null default false
);


-- ═══ 7. PAYROLL — what the importer needs on top of 07-hr ══════════════════
-- The Drive workbook (FY 2026-27 Payroll-Overall.xlsx) stays master. These
-- columns record WHERE a run came from, so a number on screen can always be
-- traced back to the file and row it was read out of.

alter table hr.payroll_runs
  add column if not exists app_id      text,
  add column if not exists headcount   int,
  add column if not exists source_file text,
  add column if not exists source_drive_id text,
  add column if not exists imported_at timestamptz,
  add column if not exists imported_by uuid;

do $$ begin
  if not exists (select 1 from pg_indexes where schemaname='hr' and indexname='hr_payroll_app_idx') then
    create unique index hr_payroll_app_idx on hr.payroll_runs (app_id) where app_id is not null;
  end if;
end $$;

alter table hr.payslips
  add column if not exists app_id       text,
  add column if not exists source_row   int,
  -- A row the importer could not match to a person. Kept, not dropped: a
  -- silently discarded payslip is how a person stops being paid.
  add column if not exists unmatched_name text,
  add column if not exists unmatched_code text;

alter table hr.payslips alter column employee_id drop not null;


-- ═══ 8. THE FUTURE KEKA SEAM ═══════════════════════════════════════════════
-- Not wired yet — the API key is outstanding. These two columns are what an
-- incremental sync needs, and adding them now costs nothing while adding them
-- later means backfilling a live attendance table.

alter table hr.attendance
  add column if not exists external_id text,
  add column if not exists synced_at   timestamptz;
create unique index if not exists hr_att_external_idx
  on hr.attendance (external_id) where external_id is not null;

alter table hr.leave_requests
  add column if not exists external_id text,
  add column if not exists synced_at   timestamptz;

-- `source` already exists on hr.attendance as manual | biometric | import.
-- Widen it rather than replace it, so existing rows stay valid.
do $$
declare con text;
begin
  select conname into con from pg_constraint
   where conrelid = 'hr.attendance'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%biometric%';
  if con is not null then
    execute format('alter table hr.attendance drop constraint %I', con);
  end if;
  begin
    alter table hr.attendance add constraint hr_attendance_source_chk
      check (source in ('manual','biometric','import','keka'));
  exception when duplicate_object then null;
  end;
end $$;


-- ═══ 9. THE HR ROLE — declared now, not enforced yet ═══════════════════════
-- See the access note at the top. This is the seam for tightening decision 1.

alter table hr.employees
  add column if not exists hr_role text
    check (hr_role is null or hr_role in ('hr_lead','hrbp','chro','ic_member')),
  add column if not exists band text;

create or replace function hr.is_hr()
returns boolean
language sql stable security definer set search_path = hr, core, public as $$
  select exists (
    select 1 from hr.employees e
    join core.people p on p.id = e.person_id
    where p.auth_id = auth.uid()
      and e.hr_role in ('hr_lead','hrbp','chro')
  );
$$;

comment on function hr.is_hr is
  'NOT USED BY ANY POLICY YET. Decision of 30 Aug 2026 keeps HR on '
  'public.is_admin(). When that is tightened, swapping is_admin() for is_hr() '
  'in the policies below is the whole change — populate hr_role first, or '
  'every HR page goes dark.';


-- ═══ 10. PERMISSIONS ═══════════════════════════════════════════════════════
-- Read for admins, per decision 1. Everyone may read the things that are
-- theirs, and the two things that are nobody's secret: the policy library and
-- the holiday calendar.

alter table hr.workspace            enable row level security;
alter table hr.onboarding_journeys  enable row level security;
alter table hr.onboarding_tasks     enable row level security;
alter table hr.policies             enable row level security;
alter table hr.policy_acks          enable row level security;
alter table hr.bands                enable row level security;
alter table hr.career_tracks        enable row level security;
alter table hr.recognitions         enable row level security;
alter table hr.grievances           enable row level security;
alter table hr.grievance_notes      enable row level security;
alter table hr.discussion_slots     enable row level security;
alter table hr.discussion_bookings  enable row level security;
alter table hr.org_units            enable row level security;
alter table hr.unit_members         enable row level security;
alter table hr.holidays             enable row level security;
alter table core.work_updates       enable row level security;
alter table core.kpi_log            enable row level security;

do $$
declare t text; has_admin boolean;
begin
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_admin') into has_admin;
  if not has_admin then
    raise notice 'public.is_admin() not found — the new hr.* tables stay closed to all roles.';
    return;
  end if;

  foreach t in array array['workspace','onboarding_journeys','onboarding_tasks','policy_acks',
                           'career_tracks','grievances','grievance_notes','discussion_bookings']
  loop
    if not exists (select 1 from pg_policies
                   where schemaname='hr' and tablename=t and policyname=t||'_admin') then
      execute format('create policy %I on hr.%I for select to authenticated using (public.is_admin())', t||'_admin', t);
    end if;
    if not exists (select 1 from pg_policies
                   where schemaname='hr' and tablename=t and policyname=t||'_admin_w') then
      execute format('create policy %I on hr.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t||'_admin_w', t);
    end if;
  end loop;
end $$;

-- Open to everyone signed in: what the company expects of people is not a
-- secret, and an app that hides the holiday calendar from staff is absurd.
do $$
declare t text;
begin
  foreach t in array array['policies','bands','org_units','unit_members','holidays','discussion_slots','recognitions'] loop
    if not exists (select 1 from pg_policies
                   where schemaname='hr' and tablename=t and policyname=t||'_read_all') then
      execute format('create policy %I on hr.%I for select to authenticated using (true)', t||'_read_all', t);
    end if;
  end loop;
end $$;

-- Your own record, per row.
do $$
declare me text := '(select e.id from hr.employees e join core.people p on p.id = e.person_id where p.auth_id = auth.uid())';
begin
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='policy_acks' and policyname='ack_self') then
    execute 'create policy ack_self on hr.policy_acks for all to authenticated using (employee_id in ' || me || ') with check (employee_id in ' || me || ')';
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='onboarding_journeys' and policyname='journey_self') then
    execute 'create policy journey_self on hr.onboarding_journeys for select to authenticated using (employee_id in ' || me || ')';
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='career_tracks' and policyname='track_self') then
    execute 'create policy track_self on hr.career_tracks for select to authenticated using (employee_id in ' || me || ')';
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='discussion_bookings' and policyname='booking_self') then
    execute 'create policy booking_self on hr.discussion_bookings for all to authenticated using (employee_id in ' || me || ') with check (employee_id in ' || me || ')';
  end if;
  -- A raiser reads their own case and the notes marked for them, never the
  -- internal thread. An anonymous case has no raiser, so nobody matches.
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='grievances' and policyname='grievance_self') then
    execute 'create policy grievance_self on hr.grievances for select to authenticated using (raised_by in ' || me || ')';
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='grievance_notes' and policyname='grievance_note_self') then
    execute 'create policy grievance_note_self on hr.grievance_notes for select to authenticated using (visible_to_raiser and case_id in (select case_id from hr.grievances where raised_by in ' || me || '))';
  end if;
end $$;

-- The daily record: yours is yours, admins see everyone. A moved pms.kpi_log
-- identifies its owner as pm_id, not user_id (see the move, section 0) — the
-- self policy goes on whichever identity column the table actually has.
do $$
declare t text; ident text;
begin
  foreach t in array array['work_updates','kpi_log'] loop
    select column_name into ident
      from information_schema.columns
     where table_schema = 'core' and table_name = t
       and column_name in ('user_id', 'pm_id')
     order by case column_name when 'user_id' then 0 else 1 end
     limit 1;
    if ident is null then continue; end if;
    if not exists (select 1 from pg_policies where schemaname='core' and tablename=t and policyname=t||'_self') then
      execute format('create policy %I on core.%I for all to authenticated using (%3$I = (select id from core.people where auth_id = auth.uid())) with check (%3$I = (select id from core.people where auth_id = auth.uid()))', t||'_self', t, ident);
    end if;
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname='public' and p.proname='is_admin')
       and not exists (select 1 from pg_policies where schemaname='core' and tablename=t and policyname=t||'_admin') then
      execute format('create policy %I on core.%I for select to authenticated using (public.is_admin())', t||'_admin', t);
    end if;
  end loop;
end $$;

grant usage on schema hr to authenticated;
grant select on all tables in schema hr to authenticated;
grant insert, update, delete on hr.workspace, hr.policy_acks, hr.onboarding_tasks,
      hr.discussion_bookings, hr.grievances, hr.grievance_notes, hr.recognitions to authenticated;
grant select, insert, update on core.work_updates, core.kpi_log to authenticated;
-- RLS above is what actually decides; these grants only open the door to it.


-- ═══ 11. SEED — the reference data the app expects to find ═════════════════

insert into hr.bands (code, name, level, next_code, expects) values
  ('L1','Associate',1,'L2','Executes defined tasks with supervision. Owns quality of their own output.'),
  ('L2','Engineer / Executive',2,'L3','Owns a workstream end to end. Raises risks before they land.'),
  ('L3','Senior Engineer / Specialist',3,'L4','Owns a subsystem. Reviews others'' work. Unblocks juniors.'),
  ('L4','Lead',4,'L5','Owns delivery across a team. Answers for outcomes, not effort.'),
  ('L5','Department Head',5,'L6','Owns a function: its people, its plan and its budget.'),
  ('L6','Leadership',6,null,'Owns the direction of the company.')
on conflict (code) do update set name = excluded.name, level = excluded.level,
  next_code = excluded.next_code, expects = excluded.expects;

insert into hr.holidays (date, name) values
  ('2026-01-01','New Year''s Day'), ('2026-01-26','Republic Day'),
  ('2026-03-04','Holi'),            ('2026-03-21','Id-ul-Fitr'),
  ('2026-05-01','Labour Day'),      ('2026-08-15','Independence Day'),
  ('2026-08-28','Ganesh Chaturthi'),('2026-10-02','Gandhi Jayanti'),
  ('2026-10-20','Dussehra'),        ('2026-11-08','Diwali'),
  ('2026-11-09','Govardhan Puja'),  ('2026-12-25','Christmas')
on conflict (date) do nothing;

-- The policy library, pointed at the real documents in
-- Eb-HR & Admin-05 / eb-HR-HRBP / 08_Policies & Compliance / Org wide Policies.
insert into hr.policies (code, title, version, category, ack_required, effective_from, drive_id, summary) values
  ('COC','Code of Conduct','2026.1','Conduct',true,'2026-04-01','1tEhuDGkOhP0HKs5uEVAMlUsDyBvmAdDd',
   'How we behave with each other, with customers and with the company''s property.'),
  ('MASTER','EB Master Policy','2026.1','Handbook',true,'2026-04-01','1DgLOYKlI_pbzMTw9fD2Z-hUiNCU8is-n',
   'The full policy set with a table of contents.'),
  ('CGP','CGP — Performance & Appraisal Policy','2026.1','Performance',true,'2026-04-01','1K8gKCLURFm342GViw_8cEU_0o7dzRt2l',
   'How the quarterly performance cycle runs.'),
  ('BAND','Grade & Band Structure Policy','2026.1','Performance',false,'2026-04-01','1Hd4k7QwBlzYL_ePY4EZ0yCpw1LUaQxyEWjx6aPKmtRA',
   'The L1–L6 ladder and what moves you up one.'),
  ('WAY','The Elecbits Way','2026.1','Culture',false,'2026-04-01','1sCMJJZyK2mfJtQGkeEg99iFeMS2TZ5dn',
   'The employee handbook.')
on conflict (code, version) do nothing;

-- Give every existing employee a band so the roadmap has something to show.
update hr.employees set band = 'L2' where band is null;
