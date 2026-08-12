-- ═══════════════════════════════════════════════════════════════════════════
-- pms — PMS ODM. Engineering services through to samples (50–100 units).
--
-- This tool already exists and already has its data. Its tables live in
-- `public` because that is where they were built, and moving them would break
-- the running app for no gain. So `pms` creates NO tables: it is the ODM
-- tool's namespace over what is already there, scoped to sanctioned ODM work.
--
-- Why bother, then? Because the moment Box Build and Product exist, "the
-- tasks table" is ambiguous. `pms.tasks` is not — it is ODM's tasks, and it
-- cannot accidentally return a Box Build project's rows.
--
-- Every view is security_invoker and read-only in practice: the app keeps
-- writing public.* through its mirror exactly as it does today. Nothing here
-- changes a single byte the app reads or writes.
--
-- Requires: sanction-gate.sql, 01-core.sql, and the earlier table migrations
--           (projects-into-a-real-table, every-table-filled,
--            nested-data-into-tables, plan-and-stages).
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists pms;


-- ═══ THE TOOL'S PROJECT LIST ═══════════════════════════════════════════════
-- Sanctioned, kind = odm. Nothing else, ever. A project ULM has not sanctioned
-- simply is not in this tool.

create or replace view pms.projects
with (security_invoker = true) as
select * from core.visible('pms_odm');

comment on view pms.projects is
  'PMS ODM''s world. Un-sanction a project in ULM and it leaves this view '
  'the same second — without being deleted.';

-- The project codes in scope, used by every view below. Kept as its own view
-- so the scoping rule is written once.
create or replace view pms.scope
with (security_invoker = true) as
select project_id as id, project_code from (
  select id as project_id, project_id as project_code from core.visible('pms_odm')
) s;


-- ═══ DELIVERY ══════════════════════════════════════════════════════════════
create or replace view pms.tasks
with (security_invoker = true) as
select t.* from public.tasks t
join pms.scope s on s.project_code = t.project_id;

create or replace view pms.stages
with (security_invoker = true) as
select st.* from public.project_stages st
join pms.scope s on s.project_code = st.project_id;

create or replace view pms.team
with (security_invoker = true) as
select cs.* from core.staffing cs
join pms.scope s on s.id = cs.project_id;


-- ═══ THE DAILY RECORD ══════════════════════════════════════════════════════
-- Scrum notes that name a project are scoped to it; notes that name none are
-- the standup itself and belong to the whole ODM team, so they stay.

create or replace view pms.scrum_notes
with (security_invoker = true) as
select n.* from public.scrum_notes n
left join pms.scope s on s.project_code = n.project_id
where n.project_id is null or n.project_id = '' or s.project_code is not null;

create or replace view pms.work_updates
with (security_invoker = true) as
select * from public.work_updates;

create or replace view pms.kpi_log
with (security_invoker = true) as
select * from public.kpi_log;

create or replace view pms.trainings
with (security_invoker = true) as
select * from public.trainings;


-- ═══ MEETINGS AND WHAT CAME OUT OF THEM ════════════════════════════════════
create or replace view pms.moms
with (security_invoker = true) as
select m.* from public.moms m
join pms.scope s on s.project_code = m.project_id;

create or replace view pms.mom_ideas
with (security_invoker = true) as
select i.* from public.mom_ideas i
join public.moms m on m.app_id = i.mom_app_id
join pms.scope s on s.project_code = m.project_id;

create or replace view pms.mom_decisions
with (security_invoker = true) as
select d.* from public.mom_decisions d
join public.moms m on m.app_id = d.mom_app_id
join pms.scope s on s.project_code = m.project_id;

create or replace view pms.mom_challenges
with (security_invoker = true) as
select c.* from public.mom_challenges c
join public.moms m on m.app_id = c.mom_app_id
join pms.scope s on s.project_code = m.project_id;


-- ═══ CONVERSATION AND WHAT THE TOOL LEARNED ════════════════════════════════
-- public.messages holds project chat, global chat and the assistant log in one
-- table, separated by `scope`. Project-scoped messages follow the project;
-- global and assistant messages belong to the tool as a whole.

create or replace view pms.messages
with (security_invoker = true) as
select msg.* from public.messages msg
left join pms.scope s on s.project_code = msg.project_id
where msg.scope <> 'project' or s.project_code is not null;

create or replace view pms.project_intel
with (security_invoker = true) as
select pi.* from public.project_intel pi
join pms.scope s on s.project_code = pi.project_id;

create or replace view pms.documents
with (security_invoker = true) as
select d.* from core.documents d
join pms.scope s on s.id = d.project_id;


-- ═══ WHAT THE ODM TOOL PUBLISHES TO EVERYONE ELSE ══════════════════════════
-- Other tools do not read pms.*. They read this: where each ODM project has
-- got to, in numbers rather than prose. Finance uses it to decide a milestone
-- is billable; ULM uses it to see whether a sanction is being delivered on.

create or replace view core.delivery_status
with (security_invoker = true) as
select
  p.id                as project_id,
  p.project_id        as project_code,
  p.kind,
  p.sanction_state,
  p.status,
  p.start_date,
  p.deadline,
  count(t.*) filter (where t.status is distinct from 'done')                  as tasks_open,
  count(t.*) filter (where t.status = 'done')                                 as tasks_done,
  count(t.*) filter (where t.status is distinct from 'done' and t.date < current_date) as tasks_overdue,
  max(t.completed_at)                                                         as last_completion,
  (select count(*) from public.project_stages st
     where st.project_id = p.project_id and st.status = 'done')               as stages_done,
  (select count(*) from public.project_stages st
     where st.project_id = p.project_id)                                      as stages_total
from public.projects p
left join public.tasks t on t.project_id = p.project_id
group by p.id, p.project_id, p.kind, p.sanction_state, p.status, p.start_date, p.deadline;

comment on view core.delivery_status is
  'Delivery progress per project, in numbers. The PMS tools'' public face — '
  'Finance and ULM read this instead of a delivery tool''s own tables.';


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
-- Views only, and security_invoker, so each caller still sees exactly what
-- public.*'s own row-level policies allow them to see. Nothing is widened.

grant usage on schema pms to authenticated;
grant select on all tables in schema pms to authenticated;
grant select on core.delivery_status to authenticated;
