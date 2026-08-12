-- ═══════════════════════════════════════════════════════════════════════════
-- sales — everything before there is a project.
--
-- Sales owns the lead, the quote and the ask. It does NOT create projects.
-- The last thing it does is raise a REQUEST, which lands in ULM's inbox; ULM
-- decides. That is the whole reason the sanction gate exists, so this schema
-- has no write path into public.projects at all.
--
-- Requires: 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists sales;


-- ═══ LEADS ═════════════════════════════════════════════════════════════════
create table if not exists sales.leads (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.clients(id) on delete set null,
  org_name      text,                       -- before the org exists in core
  contact_id    uuid references core.contacts(id) on delete set null,
  title         text not null,
  source        text,                       -- referral | inbound | outbound | expo | repeat
  stage         text not null default 'new'
                  check (stage in ('new','qualifying','quoted','negotiating','won','lost','parked')),
  expected_kind text check (expected_kind is null or expected_kind in ('odm','boxbuild','product')),
  value_inr     numeric(14,2),
  probability   int check (probability is null or probability between 0 and 100),
  expected_close date,
  owner_id      uuid,                       -- the salesperson
  lost_reason   text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists leads_stage_idx on sales.leads (stage, expected_close);
create index if not exists leads_org_idx   on sales.leads (org_id);

create table if not exists sales.activities (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references sales.leads(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null,                 -- call | email | meeting | demo | site_visit
  summary    text not null,
  next_step  text,
  next_on    date,
  by_id      uuid
);
create index if not exists activities_lead_idx on sales.activities (lead_id, at desc);


-- ═══ QUOTES ════════════════════════════════════════════════════════════════
create table if not exists sales.quotes (
  id          uuid primary key default gen_random_uuid(),
  quote_no    text unique,                  -- core.next_number('quote')
  lead_id     uuid references sales.leads(id) on delete set null,
  org_id      uuid references public.clients(id) on delete set null,
  title       text not null,
  kind        text check (kind is null or kind in ('odm','boxbuild','product')),
  qty         int,
  currency    text not null default 'INR',
  subtotal    numeric(14,2) not null default 0,
  tax_pct     numeric(5,2)  not null default 18,
  total       numeric(14,2) not null default 0,
  valid_until date,
  status      text not null default 'draft'
                check (status in ('draft','sent','accepted','rejected','expired','superseded')),
  version     int not null default 1,
  supersedes  uuid references sales.quotes(id) on delete set null,
  document_id uuid references core.documents(id) on delete set null,
  sent_at     timestamptz,
  decided_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists quotes_lead_idx on sales.quotes (lead_id);
create index if not exists quotes_status_idx on sales.quotes (status);

create table if not exists sales.quote_lines (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references sales.quotes(id) on delete cascade,
  seq        int  not null default 0,
  item       text not null,
  detail     text,
  qty        numeric(12,3) not null default 1,
  uom        text not null default 'nos',
  rate       numeric(14,2) not null default 0,
  amount     numeric(14,2) generated always as (round(qty * rate, 2)) stored
);
create index if not exists quote_lines_quote_idx on sales.quote_lines (quote_id, seq);


-- ═══ THE HANDOFF — the only thing Sales sends onward ═══════════════════════
-- A request is an ASK, not a project. It carries what ULM needs to decide:
-- what the customer wants, by when, at what price, and on what evidence.
-- ULM turns an accepted request into a project; sales never does.

create table if not exists sales.requests (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references sales.leads(id) on delete set null,
  quote_id      uuid references sales.quotes(id) on delete set null,
  org_id        uuid references public.clients(id) on delete set null,
  title         text not null,
  summary       text,
  proposed_kind text check (proposed_kind is null or proposed_kind in ('odm','boxbuild','product')),
  qty           int,
  target_date   date,
  value_inr     numeric(14,2),
  po_ref        text,                        -- customer PO, if it already exists
  urgency       text not null default 'normal' check (urgency in ('low','normal','high')),
  status        text not null default 'submitted'
                  check (status in ('draft','submitted','accepted','rejected','withdrawn')),
  -- Filled in by ULM when it accepts: the project this became.
  project_id    uuid references public.projects(id) on delete set null,
  decided_at    timestamptz,
  decided_by    uuid,
  decision_note text,
  submitted_by  uuid,
  submitted_at  timestamptz not null default now()
);
create index if not exists requests_status_idx on sales.requests (status, submitted_at desc);

comment on table sales.requests is
  'Sales'' outbox and ULM''s inbox. The only bridge between the two tools; '
  'sales has no write path into public.projects.';


-- ── How ULM sees it, without reading sales' tables ────────────────────────
-- Sales publishes a view into `core`. ULM reads `core.intake`; it never
-- selects from sales.*. When a decision is made it calls the function below —
-- a contract sales owns — rather than updating sales' table itself.
--
-- This is the pattern for every tool-to-tool link in this design: a core view
-- outward, a function inward, and nothing else.

create or replace view core.intake
with (security_invoker = true) as
select r.id, r.title, r.summary, r.proposed_kind, r.qty, r.target_date,
       r.value_inr, r.po_ref, r.urgency, r.status, r.project_id,
       r.org_id, o.name as org_name,
       r.submitted_by, r.submitted_at, r.decided_at, r.decided_by, r.decision_note
from sales.requests r
left join public.clients o on o.id = r.org_id;

comment on view core.intake is
  'ULM''s inbox. The only part of the Sales tool anything else can see.';

create or replace function sales.settle_request(
  p_request uuid, p_status text, p_project uuid default null,
  p_note text default null, p_by uuid default null
) returns sales.requests
language plpgsql security definer set search_path = sales, core, public as $$
declare r sales.requests;
begin
  if p_status not in ('accepted','rejected','withdrawn') then
    raise exception 'settle_request: status must be accepted, rejected or withdrawn (got %)', p_status;
  end if;
  update sales.requests set
    status = p_status, project_id = coalesce(p_project, project_id),
    decision_note = coalesce(p_note, decision_note),
    decided_by = coalesce(p_by, decided_by), decided_at = now()
  where id = p_request returning * into r;
  if not found then raise exception 'no such request: %', p_request; end if;

  -- Also move the lead, so the salesperson does not have to remember to.
  if r.lead_id is not null and p_status = 'accepted' then
    update sales.leads set stage = 'won' where id = r.lead_id and stage <> 'won';
  end if;

  perform core.emit('sales', 'request', p_request, p_status, r.project_id, p_by,
                    jsonb_build_object('note', p_note));
  return r;
end $$;

comment on function sales.settle_request is
  'The contract ULM calls to close a request. Sales owns the write; ULM owns '
  'the decision. Grant execute to the ULM tool''s role when it ships.';

revoke execute on function sales.settle_request(uuid,text,uuid,text,uuid) from public;


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['leads','activities','quotes','quote_lines','requests'] loop
    execute format('alter table sales.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                   where schemaname='sales' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on sales.%I for select to authenticated using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

drop trigger if exists leads_touch on sales.leads;
create trigger leads_touch before update on sales.leads
  for each row execute function public.touch_updated_at();

grant usage on schema sales to authenticated;
grant select on all tables in schema sales to authenticated;
-- Write grants belong to the Sales tool's own role, added when it ships.
