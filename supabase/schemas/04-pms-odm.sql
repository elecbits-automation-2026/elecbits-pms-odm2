-- ═══════════════════════════════════════════════════════════════════════════
-- pms — PMS ODM. Engineering services through to samples (50–100 units).
--
-- The tables are already here: 00-one-structure.sql moved them out of
-- `public`, where they were built when there was only one tool, and gave them
-- the names they should have had —
--
--     pms.workspace   pms.tasks       pms.stages     pms.scrum_notes
--     pms.meetings    pms.meeting_ideas / _decisions / _challenges
--     pms.messages    pms.intel       pms.work_updates   pms.kpi_log
--
-- So this file adds only what a tool needs on top of its own tables: the
-- project list it is allowed to see, and the one view it publishes outward.
--
-- Requires: 00-one-structure.sql, sanction-gate.sql, 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists pms;


-- ═══ THE TOOL'S PROJECT LIST ═══════════════════════════════════════════════
-- Sanctioned, kind = odm. Nothing else, ever. A project ULM has not
-- sanctioned simply is not in this tool.
--
-- Note what this is NOT: core.projects still holds every project in the
-- company, Box Build and Product included. This view is the ODM tool's window
-- onto it, and the window is the sanction gate.

create or replace view pms.projects
with (security_invoker = true) as
select * from core.visible('pms_odm');

comment on view pms.projects is
  'PMS ODM''s world. Un-sanction a project in ULM and it leaves this view the '
  'same second — without being deleted.';

-- Who is on those projects. core.staffing is company-wide; this is ODM's slice.
create or replace view pms.team
with (security_invoker = true) as
select s.* from core.staffing s
join pms.projects p on p.id = s.project_id;


-- ═══ WHAT THE ODM TOOL PUBLISHES TO EVERYONE ELSE ══════════════════════════
-- Other tools do not read pms.*. They read this: where each project has got
-- to, in numbers rather than prose. Finance uses it to decide a milestone is
-- billable; ULM uses it to see whether a sanction is being delivered on.
--
-- It covers every project, not just ODM ones, so that when Box Build and
-- Product ship they can publish into the same shape rather than inventing a
-- second one.

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
  count(t.*) filter (where t.status is distinct from 'done'
                       and t.date < current_date)                             as tasks_overdue,
  max(t.completed_at)                                                         as last_completion,
  (select count(*) from pms.stages st
     where st.project_id = p.project_id and st.status = 'done')               as stages_done,
  (select count(*) from pms.stages st
     where st.project_id = p.project_id)                                      as stages_total
from core.projects p
left join pms.tasks t on t.project_id = p.project_id
group by p.id, p.project_id, p.kind, p.sanction_state, p.status, p.start_date, p.deadline;

comment on view core.delivery_status is
  'Delivery progress per project, in numbers. The PMS tools'' public face — '
  'Finance and ULM read this instead of a delivery tool''s own tables.';


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
-- The tables' own grants and policies came with them in 00-one-structure.sql.
-- These two views are security_invoker, so each caller still sees exactly what
-- core.projects' own policies allow. Nothing is widened.

grant usage on schema pms to authenticated;
grant select on pms.projects, pms.team to authenticated;
grant select on core.delivery_status to authenticated;
