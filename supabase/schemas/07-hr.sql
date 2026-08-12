-- ═══════════════════════════════════════════════════════════════════════════
-- hr — people. NOT projects.
--
-- HR's subject is the person: who works here, on what terms, who is in today,
-- who is on leave, how they are doing, and what they are paid. It has no
-- project list and does not need one — its only view of delivery is
-- core.staffing, which says who is booked on live work.
--
-- This schema holds the most sensitive data in the company. Two consequences,
-- both enforced below rather than assumed:
--   • Salary lives in ONE table (hr.compensation), not spread across others.
--   • Read policies are admin-only, not "any signed-in user". The rest of the
--     app ships the anon key in a browser; nothing here is exposed to it.
--
-- Requires: sanction-gate.sql, 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists hr;


-- ═══ THE EMPLOYEE ══════════════════════════════════════════════════════════
-- core.people is the roster the ODM app already maintains. This does not
-- duplicate it — it hangs the employment facts off it, one row per person.

create table if not exists hr.employees (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid unique references core.people(id) on delete set null,
  emp_code      text unique,
  legal_name    text,
  personal_email text,
  phone         text,
  date_of_birth date,
  date_of_joining date,
  date_of_exit  date,
  exit_reason   text,
  employment_type text not null default 'full_time'
                  check (employment_type in ('full_time','intern','contract','consultant')),
  manager_id    uuid references hr.employees(id) on delete set null,
  location      text,
  status        text not null default 'active'
                  check (status in ('active','probation','notice','exited','on_leave')),
  pan           text,
  uan           text,
  bank_masked   text,                        -- last 4 only; the full number does not belong here
  emergency     jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists hr_employees_status_idx  on hr.employees (status);
create index if not exists hr_employees_manager_idx on hr.employees (manager_id);

-- Salary, alone, so it can be locked down on its own.
create table if not exists hr.compensation (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  effective_from date not null,
  effective_to date,
  ctc_annual   numeric(14,2),
  fixed_monthly numeric(14,2),
  variable_pct numeric(5,2),
  currency     text not null default 'INR',
  reason       text,                          -- hire | revision | promotion | correction
  approved_by  uuid,
  created_at   timestamptz not null default now()
);
create index if not exists hr_comp_emp_idx on hr.compensation (employee_id, effective_from desc);


-- ═══ TIME ══════════════════════════════════════════════════════════════════
create table if not exists hr.attendance (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  date        date not null,
  status      text not null default 'present'
                check (status in ('present','absent','leave','holiday','week_off','half_day','wfh')),
  in_at       timestamptz,
  out_at      timestamptz,
  hours       numeric(5,2),
  source      text not null default 'manual',  -- manual | biometric | import
  note        text
);
create unique index if not exists hr_attendance_idx on hr.attendance (employee_id, date);

create table if not exists hr.leave_types (
  code       text primary key,                -- CL | SL | EL | LOP | COMP
  name       text not null,
  annual_quota numeric(5,1),
  carry_forward boolean not null default false,
  paid       boolean not null default true
);
insert into hr.leave_types (code, name, annual_quota, carry_forward, paid) values
  ('CL','Casual Leave',    12, false, true),
  ('SL','Sick Leave',       6, false, true),
  ('EL','Earned Leave',    15, true,  true),
  ('COMP','Compensatory Off', null, false, true),
  ('LOP','Loss of Pay',   null, false, false)
on conflict (code) do nothing;

create table if not exists hr.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  type_code   text not null references hr.leave_types(code),
  from_date   date not null,
  to_date     date not null,
  days        numeric(5,1) not null,
  reason      text,
  status      text not null default 'pending'
                check (status in ('pending','approved','rejected','cancelled')),
  approver_id uuid references hr.employees(id) on delete set null,
  decided_at  timestamptz,
  decision_note text,
  applied_at  timestamptz not null default now(),
  check (to_date >= from_date)
);
create index if not exists hr_leave_emp_idx    on hr.leave_requests (employee_id, from_date desc);
create index if not exists hr_leave_status_idx on hr.leave_requests (status) where status = 'pending';

create table if not exists hr.leave_balances (
  employee_id uuid not null references hr.employees(id) on delete cascade,
  type_code   text not null references hr.leave_types(code),
  year        int  not null,
  opening     numeric(5,1) not null default 0,
  accrued     numeric(5,1) not null default 0,
  taken       numeric(5,1) not null default 0,
  balance     numeric(5,1) generated always as (opening + accrued - taken) stored,
  primary key (employee_id, type_code, year)
);


-- ═══ PERFORMANCE ═══════════════════════════════════════════════════════════
-- The ODM app already scores daily work in public.kpi_log and
-- public.work_updates. This is the periodic review that sits above it — it
-- does not replace the daily record, and HR reads that record through
-- core.staffing rather than reaching into the delivery tool.

create table if not exists hr.review_cycles (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,                    -- 'H1 FY26'
  from_date date not null,
  to_date   date not null,
  status    text not null default 'open' check (status in ('open','in_review','closed'))
);

create table if not exists hr.appraisals (
  id          uuid primary key default gen_random_uuid(),
  cycle_id    uuid references hr.review_cycles(id) on delete cascade,
  employee_id uuid not null references hr.employees(id) on delete cascade,
  reviewer_id uuid references hr.employees(id) on delete set null,
  self_note   text,
  reviewer_note text,
  rating      int check (rating is null or rating between 1 and 5),
  strengths   text,
  improvements text,
  outcome     text check (outcome is null or outcome in ('exceeds','meets','below','pip')),
  hike_pct    numeric(5,2),
  promoted_to text,
  status      text not null default 'draft'
                check (status in ('draft','self_done','reviewed','finalised')),
  finalised_at timestamptz
);
create unique index if not exists hr_appraisal_idx on hr.appraisals (cycle_id, employee_id);

create table if not exists hr.goals (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  cycle_id    uuid references hr.review_cycles(id) on delete set null,
  title       text not null,
  metric      text,
  target      text,
  weight_pct  numeric(5,2),
  progress_pct numeric(5,2) not null default 0,
  status      text not null default 'open' check (status in ('open','done','dropped')),
  due_on      date
);
create index if not exists hr_goals_emp_idx on hr.goals (employee_id, cycle_id);


-- ═══ PAYROLL ═══════════════════════════════════════════════════════════════
create table if not exists hr.payroll_runs (
  id          uuid primary key default gen_random_uuid(),
  period      date not null,                  -- first of the month
  status      text not null default 'draft'
                check (status in ('draft','locked','paid')),
  gross_total numeric(14,2),
  net_total   numeric(14,2),
  run_by      uuid,
  locked_at   timestamptz,
  paid_at     timestamptz
);
create unique index if not exists hr_payroll_period_idx on hr.payroll_runs (period);

create table if not exists hr.payslips (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references hr.payroll_runs(id) on delete cascade,
  employee_id uuid not null references hr.employees(id) on delete cascade,
  days_paid   numeric(5,1),
  lop_days    numeric(5,1) not null default 0,
  earnings    jsonb not null default '{}'::jsonb,   -- {basic, hra, special, …}
  deductions  jsonb not null default '{}'::jsonb,   -- {pf, pt, tds, …}
  gross       numeric(14,2),
  net         numeric(14,2),
  document_id uuid references core.documents(id) on delete set null
);
create unique index if not exists hr_payslip_idx on hr.payslips (run_id, employee_id);


-- ═══ HIRING ════════════════════════════════════════════════════════════════
create table if not exists hr.openings (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  dept        text,
  slot        text,                            -- matches the roster's resource_role
  count       int not null default 1,
  budget_ctc  numeric(14,2),
  urgency     text not null default 'normal' check (urgency in ('low','normal','high')),
  status      text not null default 'open' check (status in ('open','on_hold','filled','cancelled')),
  raised_by   uuid,
  raised_at   timestamptz not null default now(),
  closed_at   timestamptz
);

create table if not exists hr.candidates (
  id          uuid primary key default gen_random_uuid(),
  opening_id  uuid references hr.openings(id) on delete set null,
  name        text not null,
  email       text,
  phone       text,
  source      text,                            -- referral | naukri | linkedin | campus
  current_ctc numeric(14,2),
  expected_ctc numeric(14,2),
  notice_days int,
  stage       text not null default 'applied'
                check (stage in ('applied','screened','interview_1','interview_2','offer','joined','rejected','dropped')),
  rating      int check (rating is null or rating between 1 and 5),
  resume_document_id uuid references core.documents(id) on delete set null,
  notes       text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists hr_candidates_stage_idx on hr.candidates (stage, opening_id);


-- ═══ HR'S ONE WINDOW ONTO DELIVERY ═════════════════════════════════════════
-- Not a project list. Headcount against live work — the question HR actually
-- asks: who is on something, who is on nothing, and who is on too much.

create or replace view hr.utilisation
with (security_invoker = true) as
select pr.id                     as person_id,
       pr.name,
       pr.dept,
       pr.title,
       count(s.project_id) filter (where s.project_live)  as live_projects,
       count(s.project_id)                                as total_bookings,
       pr.max_projects,
       case
         when count(s.project_id) filter (where s.project_live) = 0 then 'free'
         when pr.max_projects is not null
          and count(s.project_id) filter (where s.project_live) > pr.max_projects then 'over'
         else 'ok'
       end                                                as load
from core.people pr
left join core.staffing s on s.person_id = pr.id
group by pr.id, pr.name, pr.dept, pr.title, pr.max_projects;

comment on view hr.utilisation is
  'HR''s entire relationship with projects: who is booked on live work. It '
  'reads core.staffing, never a delivery tool''s tables.';


-- ═══ PERMISSIONS — tighter than everywhere else, deliberately ══════════════
-- Salary, appraisals and candidates are admin-only. There is no
-- "any signed-in user can read HR" policy anywhere in this file.

alter table hr.employees      enable row level security;
alter table hr.compensation   enable row level security;
alter table hr.attendance     enable row level security;
alter table hr.leave_types    enable row level security;
alter table hr.leave_requests enable row level security;
alter table hr.leave_balances enable row level security;
alter table hr.review_cycles  enable row level security;
alter table hr.appraisals     enable row level security;
alter table hr.goals          enable row level security;
alter table hr.payroll_runs   enable row level security;
alter table hr.payslips       enable row level security;
alter table hr.openings       enable row level security;
alter table hr.candidates     enable row level security;

-- public.is_admin() already exists (superadmin | dept_head). If it somehow
-- does not, everything here stays closed rather than falling open.
do $$
declare t text; has_admin boolean;
begin
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_admin') into has_admin;
  if not has_admin then
    raise notice 'public.is_admin() not found — hr.* stays closed to all roles.';
    return;
  end if;

  foreach t in array array['employees','compensation','attendance','leave_types',
                           'leave_requests','leave_balances','review_cycles','appraisals',
                           'goals','payroll_runs','payslips','openings','candidates'] loop
    if not exists (select 1 from pg_policies
                   where schemaname='hr' and tablename=t and policyname=t||'_admin') then
      execute format(
        'create policy %I on hr.%I for select to authenticated using (public.is_admin())',
        t||'_admin', t);
    end if;
  end loop;
end $$;

-- Everyone may see their OWN record — the one exception, and it is per-row.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='employees' and policyname='employees_self') then
    create policy employees_self on hr.employees for select to authenticated
      using (person_id in (select id from core.people where auth_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='leave_requests' and policyname='leave_self') then
    create policy leave_self on hr.leave_requests for select to authenticated
      using (employee_id in (select e.id from hr.employees e
                             join core.people p on p.id = e.person_id
                             where p.auth_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='hr' and tablename='payslips' and policyname='payslip_self') then
    create policy payslip_self on hr.payslips for select to authenticated
      using (employee_id in (select e.id from hr.employees e
                             join core.people p on p.id = e.person_id
                             where p.auth_id = auth.uid()));
  end if;
end $$;

drop trigger if exists hr_employees_touch on hr.employees;
create trigger hr_employees_touch before update on hr.employees
  for each row execute function public.touch_updated_at();

grant usage on schema hr to authenticated;
grant select on all tables in schema hr to authenticated;   -- RLS above is what actually decides

-- Seed employees from the roster the ODM app already maintains, so HR starts
-- with the 24 people rather than an empty table. Nothing is overwritten.
insert into hr.employees (person_id, legal_name, status)
select p.id, p.name, 'active'
from core.people p
where coalesce(p.email,'') <> ''
  and not exists (select 1 from hr.employees e where e.person_id = p.id);
