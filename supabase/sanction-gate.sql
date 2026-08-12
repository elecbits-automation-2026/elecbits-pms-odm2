-- ═══════════════════════════════════════════════════════════════════════════
-- THE SANCTION GATE — one project spine, six tools, ULM holds the switch.
--
-- The model this implements:
--
--   Sales raises a project  →  ULM reviews it  →  ULM SANCTIONS it and routes
--   it to exactly one delivery tool (ODM / Box Build / Product).  Only after
--   that does the project appear anywhere else.  ULM can UN-SANCTION at any
--   time and it disappears from the delivery tools again — without being
--   deleted, and without losing a day of its history.
--
-- Two rules make this safe to run against the live app:
--
--   1. NOTHING IS RENAMED, NOTHING IS DROPPED, NOTHING BECOMES REQUIRED.
--      Every change is an added column, an added table, or an added view.
--      `public.projects` keeps every column it has, including the old
--      `sanctioned` boolean the ODM app derives from status. The mirror in
--      src/lib/tableSync.js keeps writing exactly the same columns it writes
--      today and keeps succeeding.
--
--   2. THE ODM APP IS NOT ASKED TO CHANGE. It writes `public.projects`; the
--      new tools read `core.projects`, which is a VIEW over that same physical
--      table. There is no second copy of a project and nothing to keep in
--      sync. Truth has one home.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. THE SPINE — additive columns on public.projects ════════════════════
-- These are the four facts the company needs about a project that the ODM app
-- alone never had to know: is it sanctioned, who decided that, which delivery
-- tool owns it, and what did it come out of.

alter table public.projects
  -- ULM's decision. This is a STATE, not a derivation. The ODM app's
  -- `sanctioned` boolean stays where it is and keeps meaning what it always
  -- meant to that app ("status is past Planning"); it is no longer what the
  -- rest of the company reads.
  add column if not exists sanction_state    text not null default 'draft',

  -- Which delivery tool owns it once sanctioned.
  add column if not exists kind              text,          -- odm | boxbuild | product

  -- The decision trail, denormalised onto the row so every tool can show
  -- "sanctioned by X on Y" without joining into ULM's schema.
  add column if not exists sanctioned_at     timestamptz,
  add column if not exists sanctioned_by     uuid,
  add column if not exists unsanctioned_at   timestamptz,
  add column if not exists sanction_reason   text,

  -- Lineage: an ODM sample run becomes a Box Build order becomes a Product.
  -- Same customer, same hardware, three projects, one thread.
  add column if not exists parent_id         uuid,

  -- Who raised it, and who owns it commercially. Nullable — nothing enforces
  -- these until the Sales and ULM tools exist to fill them.
  add column if not exists requested_by      uuid,
  add column if not exists requested_at      timestamptz,
  add column if not exists org_id            uuid;

-- The allowed states. Added as NOT VALID first so the constraint applies to
-- new and updated rows immediately without a full-table verification pass
-- against data written before this ran.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_sanction_state_ck') then
    alter table public.projects
      add constraint projects_sanction_state_ck
      check (sanction_state in ('draft','requested','sanctioned','unsanctioned','on_hold','closed'))
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_kind_ck') then
    alter table public.projects
      add constraint projects_kind_ck
      check (kind is null or kind in ('odm','boxbuild','product'))
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_parent_fk') then
    alter table public.projects
      add constraint projects_parent_fk foreign key (parent_id)
      references public.projects(id) on delete set null not valid;
  end if;
end $$;

-- THE gate every other tool reads. Generated, so it can never disagree with
-- the state, and can never be written by accident — not by the ODM mirror,
-- not by a new tool, not by hand.
alter table public.projects
  add column if not exists is_sanctioned boolean
  generated always as (sanction_state = 'sanctioned') stored;

create index if not exists projects_gate_idx   on public.projects (is_sanctioned, kind);
create index if not exists projects_state_idx  on public.projects (sanction_state);
create index if not exists projects_parent_idx on public.projects (parent_id);

comment on column public.projects.sanctioned is
  'LEGACY / ODM-app only: derived from status <> ''Planning'' by src/lib/tableSync.js. '
  'Do NOT read this outside the ODM app — read is_sanctioned, which reflects ULM''s decision.';
comment on column public.projects.sanction_state is
  'ULM-owned lifecycle: draft → requested → sanctioned ⇄ unsanctioned/on_hold → closed. '
  'Written only through pmo.decide(); never by a delivery tool.';
comment on column public.projects.is_sanctioned is
  'The gate. True only while ULM has the project sanctioned. Generated — never written.';

-- ── Anything born in a delivery tool lands in ULM's inbox ──────────────────
-- The ODM app's mirror inserts project rows without knowing sanction exists.
-- Rather than have those rows sit in 'draft' where nobody looks, stamp them as
-- 'requested' ODM work on the way in. ULM then sanctions or rejects them. A
-- row that arrives with a state already set (i.e. from the ULM tool) is left
-- exactly as it is.
create or replace function public.projects_default_intake() returns trigger
language plpgsql as $$
begin
  if new.sanction_state = 'draft' then
    new.sanction_state := 'requested';
    new.kind           := coalesce(new.kind, 'odm');
    new.requested_at   := coalesce(new.requested_at, now());
  end if;
  return new;
end $$;

drop trigger if exists projects_intake on public.projects;
create trigger projects_intake before insert on public.projects
  for each row execute function public.projects_default_intake();


-- ═══ 2. BACKFILL — the 12 live projects are already real work ══════════════
-- Everything currently in the tool came in through the ODM route and is being
-- delivered today, so it is sanctioned ODM work. Anything still sitting in
-- Planning is treated as raised-but-not-yet-decided, which is exactly what
-- Planning has always meant here.

update public.projects
set kind = coalesce(kind, 'odm')
where kind is null;

update public.projects
set sanction_state = case
      when coalesce(status,'Planning') = 'Planning' then 'requested'
      when status in ('Completed','Delivered','Closed')  then 'closed'
      else 'sanctioned'
    end,
    sanctioned_at = case
      when coalesce(status,'Planning') <> 'Planning' then coalesce(sanctioned_at, created_at)
      else sanctioned_at
    end
where sanction_state = 'draft';


-- ═══ 3. core — the shared façade every tool points at ══════════════════════
-- `core` owns nothing physical for projects. It is the agreed shape of a
-- project, so that when the ODM app's storage eventually changes, five other
-- tools do not have to.

create schema if not exists core;

-- The six tools, as data rather than as if/else in six codebases.
create table if not exists core.tools (
  key         text primary key,          -- 'pms_odm', 'hr', …
  name        text not null,
  sees_kinds  text[]  not null default '{}',   -- {} = every kind
  sees_states text[]  not null default '{sanctioned}',
  sort_order  int     not null default 100
);

insert into core.tools (key, name, sees_kinds, sees_states, sort_order) values
  ('pmo',        'ULM / Project Allocation & Architecture', '{}',
     '{draft,requested,sanctioned,unsanctioned,on_hold,closed}', 10),
  ('pms_odm',    'PMS ODM',        '{odm}',      '{sanctioned}', 20),
  ('pms_bb',     'PMS Box Build',  '{boxbuild}', '{sanctioned}', 30),
  ('pms_product','PMS Product',    '{product}',  '{sanctioned}', 40),
  ('hr',         'HR',             '{}',         '{sanctioned,on_hold}', 50),
  ('finance',    'Finance',        '{}',         '{sanctioned,on_hold,closed}', 60)
on conflict (key) do update
  set name = excluded.name, sees_kinds = excluded.sees_kinds,
      sees_states = excluded.sees_states, sort_order = excluded.sort_order;

-- The project, as the company sees it. A plain updatable view over the one
-- physical table — no copy, no drift, no sync job.
create or replace view core.projects
with (security_invoker = true) as
select
  p.id,
  p.project_id,
  p.name,
  p.description,
  p.kind,
  p.sanction_state,
  p.is_sanctioned          as sanctioned,
  p.sanctioned_at,
  p.sanctioned_by,
  p.unsanctioned_at,
  p.sanction_reason,
  p.parent_id,
  p.org_id,
  p.client_id,
  p.client_name,
  p.status,
  p.start_date,
  p.deadline,
  p.team,
  p.requested_by,
  p.requested_at,
  p.created_at,
  p.updated_at
from public.projects p;

comment on view core.projects is
  'The company-wide project. Backed by public.projects so the ODM app is untouched. '
  'Every tool reads this; no tool reads another tool''s tables.';

-- People, minus the columns no delivery tool has any business seeing.
create or replace view core.people
with (security_invoker = true) as
select id, auth_id, name, email, role, title, resource_role, dept,
       skills, max_projects, color, created_at
from public.profiles;

-- "What can this tool see?" — one function, six answers, zero duplicated
-- filter logic. A tool calls core.visible('hr') and gets its project list.
create or replace function core.visible(tool_key text)
returns setof core.projects
language sql stable security invoker as $$
  select p.* from core.projects p, core.tools t
  where t.key = tool_key
    and p.sanction_state = any (t.sees_states)
    and (cardinality(t.sees_kinds) = 0 or p.kind = any (t.sees_kinds));
$$;

comment on function core.visible(text) is
  'The routing rule, in one place. Sanctioned + matching kind for the three PMS '
  'tools; sanctioned regardless of kind for HR and Finance; everything for ULM.';


-- ═══ 4. pmo — the ULM tool's own schema ════════════════════════════════════
-- ULM is the only writer of sanction state. The decision LEDGER lives here and
-- is append-only; the state on the project row is a projection of it kept by a
-- trigger, so "current state" is fast and "how did it get here" is complete.

create schema if not exists pmo;

create table if not exists pmo.sanction_events (
  id          uuid primary key default gen_random_uuid(),
  -- ON DELETE SET NULL, not CASCADE, and the project's code kept alongside:
  -- if a project is ever deleted in a delivery tool, the delete still succeeds
  -- (so the ODM app's sync is never rejected) and the decision history
  -- survives it. An audit trail that a project manager can erase is not one.
  project_id  uuid references public.projects(id) on delete set null,
  project_code text,
  action      text not null check (action in
                ('request','sanction','unsanction','hold','resume','route','close','reopen')),
  from_state  text,
  to_state    text not null,
  kind        text,                       -- set/changed by a 'route' or 'sanction'
  reason      text,
  decided_by  uuid,
  decided_at  timestamptz not null default now()
);
create index if not exists sanction_events_project_idx on pmo.sanction_events (project_id, decided_at desc);

comment on table pmo.sanction_events is
  'Append-only. Never UPDATE or DELETE a row here — an un-sanction is a new '
  'event, not an edit of the sanction. This is the audit trail Finance will ask for.';

-- Where a sanctioned project was sent, and to whom.
create table if not exists pmo.allocations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  tool_key    text not null references core.tools(key),
  owner_id    uuid,                       -- the PM who takes delivery
  allocated_by uuid,
  allocated_at timestamptz not null default now(),
  released_at  timestamptz,               -- set instead of deleting, on un-sanction
  note         text
);
create unique index if not exists allocations_live_idx
  on pmo.allocations (project_id) where released_at is null;

-- The architecture pass: how a sanctioned project breaks into work.
create table if not exists pmo.work_packages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  seq         int  not null default 0,
  title       text not null,
  discipline  text,                       -- hardware | firmware | mechanical | test | …
  tool_key    text references core.tools(key),
  est_days    numeric,
  owner_id    uuid,
  status      text not null default 'planned',
  created_at  timestamptz not null default now()
);
create index if not exists work_packages_project_idx on pmo.work_packages (project_id, seq);

-- ── The one door in and out of sanction ────────────────────────────────────
-- Everything writes state through here, so the ledger can never disagree with
-- the row. Delivery tools do not call this; only the ULM tool does.
create or replace function pmo.decide(
  p_project uuid,
  p_action  text,
  p_kind    text default null,
  p_reason  text default null,
  p_by      uuid default null
) returns public.projects
language plpgsql security definer set search_path = public, pmo, core as $$
declare
  cur  public.projects;
  nxt  text;
begin
  -- Lets the guard trigger below know this write is the sanctioned route in.
  perform set_config('pmo.deciding', '1', true);

  select * into cur from public.projects where id = p_project for update;
  if not found then raise exception 'no such project: %', p_project; end if;

  nxt := case p_action
           when 'request'    then 'requested'
           when 'sanction'   then 'sanctioned'
           when 'unsanction' then 'unsanctioned'
           when 'hold'       then 'on_hold'
           when 'resume'     then 'sanctioned'
           when 'route'      then cur.sanction_state      -- re-route, state unchanged
           when 'close'      then 'closed'
           when 'reopen'     then 'sanctioned'
           else null end;
  if nxt is null then raise exception 'unknown action: %', p_action; end if;

  -- A project cannot be sanctioned into thin air; it has to be routed to a
  -- delivery tool at the moment it is sanctioned.
  if nxt = 'sanctioned' and coalesce(p_kind, cur.kind) is null then
    raise exception 'sanctioning % requires a kind (odm | boxbuild | product)', cur.project_id;
  end if;

  insert into pmo.sanction_events
    (project_id, project_code, action, from_state, to_state, kind, reason, decided_by)
  values (p_project, cur.project_id, p_action, cur.sanction_state, nxt,
          coalesce(p_kind, cur.kind), p_reason, p_by);

  update public.projects set
    sanction_state  = nxt,
    kind            = coalesce(p_kind, kind),
    sanction_reason = coalesce(p_reason, sanction_reason),
    sanctioned_at   = case when nxt = 'sanctioned' then coalesce(sanctioned_at, now()) else sanctioned_at end,
    sanctioned_by   = case when nxt = 'sanctioned' then coalesce(p_by, sanctioned_by)  else sanctioned_by end,
    unsanctioned_at = case when nxt in ('unsanctioned','on_hold') then now() else unsanctioned_at end
  where id = p_project
  returning * into cur;

  -- Allocation follows the decision: sanctioning claims the project for a
  -- tool, un-sanctioning releases it (the row stays, for the history).
  if nxt = 'sanctioned' then
    insert into pmo.allocations (project_id, tool_key, allocated_by)
    select p_project,
           case cur.kind when 'odm' then 'pms_odm' when 'boxbuild' then 'pms_bb' else 'pms_product' end,
           p_by
    where not exists (
      select 1 from pmo.allocations a where a.project_id = p_project and a.released_at is null);
  elsif nxt in ('unsanctioned','closed') then
    update pmo.allocations set released_at = now()
    where project_id = p_project and released_at is null;
  end if;

  return cur;
end $$;

comment on function pmo.decide is
  'The only writer of sanction_state. Records the event, moves the row, and '
  'claims or releases the delivery-tool allocation in one transaction.';

-- ── Make "only ULM decides" true, not just intended ────────────────────────
-- Without this, any tool with an UPDATE grant on public.projects could quietly
-- sanction itself a project and leave no trace in the ledger. This refuses the
-- write unless it came through pmo.decide(). The ODM app never touches
-- sanction_state, so it never meets this trigger.
--
-- For a deliberate manual correction in the SQL editor:
--     set local pmo.override = '1';   -- then your UPDATE, in the same txn
create or replace function public.guard_sanction_state() returns trigger
language plpgsql as $$
begin
  if new.sanction_state is distinct from old.sanction_state
     and coalesce(current_setting('pmo.deciding', true), '') <> '1'
     and coalesce(current_setting('pmo.override', true), '') <> '1'
  then
    raise exception
      'sanction_state is ULM-owned: change it with pmo.decide(project, action), not a direct UPDATE'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists projects_guard_sanction on public.projects;
create trigger projects_guard_sanction before update on public.projects
  for each row execute function public.guard_sanction_state();

-- Backfill the ledger so the 12 live projects have an origin story rather than
-- appearing to have been sanctioned by nobody.
insert into pmo.sanction_events (project_id, project_code, action, from_state, to_state, kind, reason, decided_at)
select p.id, p.project_id, 'sanction', 'requested', 'sanctioned', p.kind,
       'backfilled at sanction-gate rollout', coalesce(p.sanctioned_at, p.created_at)
from public.projects p
where p.sanction_state = 'sanctioned'
  and not exists (select 1 from pmo.sanction_events e where e.project_id = p.id);

insert into pmo.allocations (project_id, tool_key, allocated_at)
select p.id,
       case p.kind when 'odm' then 'pms_odm' when 'boxbuild' then 'pms_bb' else 'pms_product' end,
       coalesce(p.sanctioned_at, p.created_at)
from public.projects p
where p.sanction_state = 'sanctioned'
  and not exists (select 1 from pmo.allocations a where a.project_id = p.id and a.released_at is null);


-- ═══ 5. WHO MAY TOUCH WHAT ═════════════════════════════════════════════════
-- The ODM app ships the anon key in the browser, so nothing here is opened to
-- anon. `core` is readable by a signed-in user; `pmo` is writable only through
-- pmo.decide(), which is SECURITY DEFINER and checks nothing else — so it must
-- stay off the anon role until the ULM tool exists with its own gate.

alter table pmo.sanction_events enable row level security;
alter table pmo.allocations     enable row level security;
alter table pmo.work_packages   enable row level security;
alter table core.tools          enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='tools' and policyname='tools_read') then
    create policy tools_read on core.tools for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='pmo' and tablename='sanction_events' and policyname='events_read') then
    create policy events_read on pmo.sanction_events for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='pmo' and tablename='allocations' and policyname='alloc_read') then
    create policy alloc_read on pmo.allocations for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='pmo' and tablename='work_packages' and policyname='wp_read') then
    create policy wp_read on pmo.work_packages for select to authenticated using (true);
  end if;
end $$;

grant usage on schema core to authenticated;
grant select on core.tools, core.projects, core.people to authenticated;
grant execute on function core.visible(text) to authenticated;

grant usage on schema pmo to authenticated;
grant select on pmo.sanction_events, pmo.allocations, pmo.work_packages to authenticated;
-- Deliberately NOT granted yet: execute on pmo.decide(). Grant it to the ULM
-- tool's role when that tool ships, not to every signed-in browser:
--   grant execute on function pmo.decide(uuid,text,text,text,uuid) to authenticated;
revoke execute on function pmo.decide(uuid,text,text,text,uuid) from public;

-- NOTE: do NOT add `core` or `pmo` to Settings → API → Exposed schemas until a
-- tool actually needs them over PostgREST. Until then they are reachable only
-- from SQL and from Edge Functions using the service-role key.


-- ═══ 6. WHAT YOU NOW HAVE ══════════════════════════════════════════════════
select t.name as tool, count(v.id) as projects_visible
from core.tools t
left join lateral core.visible(t.key) v on true
group by t.sort_order, t.name
order by t.sort_order;

select project_id, name, kind, sanction_state, is_sanctioned, sanctioned_at::date
from public.projects
order by sanction_state, project_id;
