-- ═══════════════════════════════════════════════════════════════════════════
-- ulm — project acceptance, allocation and architecture. The gate.
--
-- sanction-gate.sql already created the heart of this schema:
--     ulm.sanction_events   the append-only decision ledger
--     ulm.allocations       which tool a sanctioned project is claimed by
--     ulm.work_packages     the architecture breakdown
--     ulm.decide()          the only writer of sanction state
--
-- This adds what surrounds the decision: the review that justifies it, the
-- risks that qualify it, the capacity it assumes, and one function that turns
-- an accepted Sales request into a real, sanctioned, routed project.
--
-- Requires: sanction-gate.sql, 01-core.sql, 02-sales.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists ulm;


-- ═══ THE REVIEW — why the answer was yes or no ═════════════════════════════
-- Sanctioning is one row in the ledger. This is the working behind it, so
-- that six months later "why did we take this on at this price" has an answer.

create table if not exists ulm.reviews (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid,                        -- core.intake.id, when it came from Sales
  project_id    uuid references public.projects(id) on delete set null,
  project_code  text,
  proposed_kind text check (proposed_kind is null or proposed_kind in ('odm','boxbuild','product')),

  -- The four questions ULM actually asks.
  feasibility   int check (feasibility  is null or feasibility  between 1 and 5),
  capacity      int check (capacity     is null or capacity     between 1 and 5),
  commercial    int check (commercial   is null or commercial   between 1 and 5),
  strategic     int check (strategic    is null or strategic    between 1 and 5),
  notes         text,

  verdict       text not null default 'pending'
                  check (verdict in ('pending','accept','reject','more_info')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists reviews_verdict_idx on ulm.reviews (verdict, created_at desc);
create index if not exists reviews_project_idx on ulm.reviews (project_id);

create table if not exists ulm.risks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete set null,
  project_code text,
  title       text not null,
  detail      text,
  likelihood  int check (likelihood is null or likelihood between 1 and 5),
  impact      int check (impact     is null or impact     between 1 and 5),
  severity    int generated always as (coalesce(likelihood,0) * coalesce(impact,0)) stored,
  mitigation  text,
  owner_id    uuid,
  status      text not null default 'open' check (status in ('open','mitigated','accepted','closed')),
  raised_by   uuid,
  raised_at   timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists risks_open_idx on ulm.risks (project_id, status, severity desc);


-- ═══ CAPACITY — what the sanction assumed, before delivery starts ══════════
-- The delivery tools record who actually worked. This records who ULM said
-- would be needed. The gap between the two is the only honest measure of
-- whether the estimate was any good.

create table if not exists ulm.resource_plan (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete set null,
  project_code text,
  discipline  text not null,               -- hardware | firmware | mechanical | test | pm
  slot        text,                        -- 'Sr. Hardware Engineer', matching the roster
  person_id   uuid,                        -- if a named person was assumed
  from_date   date,
  to_date     date,
  fte         numeric(4,2) not null default 1.0 check (fte > 0 and fte <= 2),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists resource_plan_project_idx on ulm.resource_plan (project_id);
create index if not exists resource_plan_window_idx  on ulm.resource_plan (from_date, to_date);

-- Planned effort against booked people, per project. This is the view the
-- ULM dashboard is built on.
create or replace view ulm.load
with (security_invoker = true) as
select p.id           as project_id,
       p.project_id   as project_code,
       p.name,
       p.kind,
       p.sanction_state,
       coalesce(sum(rp.fte), 0)                     as planned_fte,
       (select count(*) from core.staffing s where s.project_id = p.id) as people_booked
from public.projects p
left join ulm.resource_plan rp on rp.project_id = p.id
group by p.id, p.project_id, p.name, p.kind, p.sanction_state;


-- ═══ ACCEPT — one call turns a request into a sanctioned project ═══════════
-- This is the whole ULM workflow in a single transaction: create the project,
-- sanction it, route it to a delivery tool, close the Sales request and tell
-- everyone. Doing it in one place is what stops half-accepted projects — a
-- project row with no sanction, or a sanctioned project Sales still thinks is
-- pending — from existing at all.

create or replace function ulm.accept_request(
  p_request  uuid,
  p_kind     text,
  p_code     text default null,             -- project code; generated if omitted
  p_name     text default null,
  p_deadline date default null,
  p_by       uuid default null,
  p_note     text default null
) returns public.projects
language plpgsql security definer set search_path = ulm, core, sales, public as $$
declare
  req  core.intake;
  proj public.projects;
  code text;
begin
  select * into req from core.intake where id = p_request;
  if not found then raise exception 'no such request: %', p_request; end if;
  if req.project_id is not null then
    raise exception 'request % already became project %', p_request, req.project_id;
  end if;
  if p_kind not in ('odm','boxbuild','product') then
    raise exception 'kind must be odm, boxbuild or product (got %)', p_kind;
  end if;

  code := coalesce(nullif(trim(p_code), ''), core.next_number('project'));

  -- Born already decided: the intake trigger's 'requested' default is
  -- overridden here, because ULM is the thing that decides.
  insert into public.projects
    (project_id, name, client_id, client_name, status, deadline,
     sanction_state, kind, requested_by, requested_at, org_id)
  values
    (code, coalesce(nullif(trim(p_name), ''), req.title),
     (select client_id from public.clients where id = req.org_id),
     req.org_name, 'Planning', coalesce(p_deadline, req.target_date),
     'requested', p_kind, req.submitted_by, req.submitted_at, req.org_id)
  returning * into proj;

  -- Sanction it through the one door, so the ledger and the row agree.
  proj := ulm.decide(proj.id, 'sanction', p_kind,
                     coalesce(p_note, 'accepted from request ' || p_request::text), p_by);

  -- Close the Sales side through sales' own contract, not by touching its table.
  perform sales.settle_request(p_request, 'accepted', proj.id, p_note, p_by);

  insert into ulm.reviews (request_id, project_id, project_code, proposed_kind,
                           verdict, reviewed_by, reviewed_at, notes)
  values (p_request, proj.id, proj.project_id, p_kind, 'accept', p_by, now(), p_note);

  perform core.emit('ulm', 'project', proj.id, 'sanctioned', proj.id, p_by,
                    jsonb_build_object('kind', p_kind, 'code', proj.project_id));
  return proj;
end $$;

comment on function ulm.accept_request is
  'Request → project → sanction → route → close the request, in one '
  'transaction. Either all of it happened or none of it did.';

revoke execute on function ulm.accept_request(uuid,text,text,text,date,uuid,text) from public;

-- ULM must be able to close a Sales request; that grant is the bridge.
-- Both are SECURITY DEFINER, so this is a contract, not table access.
grant execute on function sales.settle_request(uuid,text,uuid,text,uuid) to postgres;


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['reviews','risks','resource_plan'] loop
    execute format('alter table ulm.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                   where schemaname='ulm' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on ulm.%I for select to authenticated using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

grant usage on schema ulm to authenticated;
grant select on all tables in schema ulm to authenticated;
-- Still NOT granted to authenticated: ulm.decide() and ulm.accept_request().
-- They go to the ULM tool's role when that tool ships with its own auth.
