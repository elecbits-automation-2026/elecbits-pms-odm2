-- ═══════════════════════════════════════════════════════════════════════════
-- core — the shared spine. Everything every tool agrees on.
--
-- Run order:  sanction-gate.sql  →  01-core.sql  →  02..08 in any order.
--
-- sanction-gate.sql already created core.tools, core.projects, core.people,
-- core.staffing and core.visible(). This adds the rest of the shared spine:
-- the organisations, the contacts, the documents, the cross-tool event log
-- and the document numbering.
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE:
--   Every tool may read `core`. NO tool ever reads another tool's schema.
--   When Box Build needs to tell Finance something, it writes core.events —
--   it does not reach into fin.
--
-- Nothing here touches the running ODM app. `core.orgs` is a view over
-- core.orgs, which the app already writes, so customers have one home.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists core;
create extension if not exists pgcrypto;


-- ═══ 0. THE OTHER TWO TOOLS ════════════════════════════════════════════════
-- sanction-gate.sql registered the six tools that consume sanctioned
-- projects. Sales and Management are tools too — they just sit either side of
-- that list. They need to be here because core.tools is also the registry
-- every tool_key column in this design points at, and because core.events
-- refuses an event from a tool it has never heard of.

insert into core.tools (key, name, sees_kinds, sees_states, sort_order) values
  -- Sales sits BEFORE the gate. It sees sanctioned projects because a
  -- salesperson on a customer call needs to know where the work has got to —
  -- but it reads status through core.delivery_status, never a PMS tool.
  ('sales', 'Sales', '{}', '{sanctioned,on_hold,closed}', 5),
  -- Management sits above it and sees everything, including what was rejected.
  ('mgmt',  'Management', '{}',
     '{draft,requested,sanctioned,unsanctioned,on_hold,closed}', 70)
on conflict (key) do update
  set name = excluded.name, sees_kinds = excluded.sees_kinds,
      sees_states = excluded.sees_states, sort_order = excluded.sort_order;


-- ═══ 1. ORGANISATIONS — customers, vendors, partners ═══════════════════════
-- core.orgs is the roster of customers the ODM app has always written (it was
-- public.clients until 00-one-structure.sql moved it). These columns are what
-- the rest of the company needs and the app never had; all nullable, so the
-- app's writes keep working untouched.

alter table core.orgs
  add column if not exists kind        text,        -- customer | vendor | partner | internal
  add column if not exists gstin       text,
  add column if not exists pan         text,
  add column if not exists website     text,
  add column if not exists address     jsonb not null default '{}'::jsonb,
  add column if not exists payment_terms_days int,
  add column if not exists credit_limit numeric(14,2),
  add column if not exists owner_id    uuid,        -- the account manager
  add column if not exists active      boolean not null default true,
  add column if not exists notes       text;

update core.orgs set kind = 'customer' where kind is null;

create index if not exists clients_kind_idx on core.orgs (kind) where active;

comment on table core.orgs is
  'Every company we deal with — customer, vendor, partner. One list, shared by
   Sales, the three PMS tools and Finance. `client_id` is the human-readable
   code the ODM app has always used.';

-- A named human at an organisation. The ODM app keeps a `contact` blob on the
-- project; this is the company-wide address book that Sales and Finance need.
create table if not exists core.contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references core.orgs(id) on delete cascade,
  name       text not null,
  role       text,
  email      text,
  phone      text,
  is_primary boolean not null default false,
  notes      text,
  created_at timestamptz not null default now()
);
create index if not exists contacts_org_idx on core.contacts (org_id);
create unique index if not exists contacts_primary_idx
  on core.contacts (org_id) where is_primary;


-- ═══ 2. DOCUMENTS — one place that knows where a file lives ════════════════
-- Drive is the store; this is the index. A quote, an LLD, a BOM, a PO, an
-- invoice and a test report all land here, so any tool can find a project's
-- paperwork without knowing which tool produced it.

create table if not exists core.documents (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references core.projects(id) on delete set null,
  project_code text,
  org_id       uuid references core.orgs(id) on delete set null,
  tool_key     text references core.tools(key),      -- who produced it
  kind         text not null,                        -- lld | bom | quote | po | invoice | report | …
  title        text not null,
  drive_id     text,                                 -- Google Drive file id
  url          text,
  mime         text,
  size_bytes   bigint,
  version      int not null default 1,
  supersedes   uuid references core.documents(id) on delete set null,
  owner_email  text,                                 -- whose Drive it sits in
  uploaded_by  uuid,
  uploaded_at  timestamptz not null default now()
);
create index if not exists documents_project_idx on core.documents (project_id, kind);
create index if not exists documents_drive_idx   on core.documents (drive_id);

comment on table core.documents is
  'The file index, not the files. owner_email records whose Drive actually '
  'holds it, which is what per-person upload attribution produces.';


-- ═══ 3. EVENTS — how tools talk without touching each other ════════════════
-- Box Build finishing a batch is Finance's cue to invoice and HR's cue to
-- free the team. Instead of Box Build writing into fin and hr — which would
-- break the one rule this design has — it writes an event, and whoever cares
-- reads it.

create table if not exists core.events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  tool_key    text references core.tools(key),
  entity      text not null,          -- 'project' | 'order' | 'invoice' | …
  entity_id   uuid,
  project_id  uuid references core.projects(id) on delete set null,
  verb        text not null,          -- 'created' | 'sanctioned' | 'shipped' | …
  actor_id    uuid,
  payload     jsonb not null default '{}'::jsonb
);
create index if not exists events_project_idx on core.events (project_id, at desc);
create index if not exists events_feed_idx    on core.events (at desc);
create index if not exists events_entity_idx  on core.events (entity, entity_id);

create or replace function core.emit(
  p_tool text, p_entity text, p_entity_id uuid, p_verb text,
  p_project uuid default null, p_actor uuid default null, p_payload jsonb default '{}'::jsonb
) returns bigint
language sql security definer set search_path = core, public as $$
  insert into core.events (tool_key, entity, entity_id, verb, project_id, actor_id, payload)
  values (p_tool, p_entity, p_entity_id, p_verb, p_project, p_actor, p_payload)
  returning id;
$$;

comment on function core.emit is
  'The only sanctioned way for one tool to inform another. Append-only.';


-- ═══ 4. NUMBERING — EB-…, PO-…, INV-… without two people colliding ═════════

create table if not exists core.numbering (
  kind       text primary key,        -- 'project' | 'po' | 'invoice' | 'quote' | …
  prefix     text not null,
  width      int  not null default 4,
  per_year   boolean not null default true,
  last_year  int,
  last_value int  not null default 0
);

insert into core.numbering (kind, prefix, width, per_year) values
  ('project', 'Eb-',  4, false),
  ('quote',   'QT-',  4, true),
  ('po',      'PO-',  4, true),
  ('invoice', 'INV-', 4, true),
  ('grn',     'GRN-', 4, true),
  ('dc',      'DC-',  4, true)
on conflict (kind) do nothing;

create or replace function core.next_number(p_kind text)
returns text
language plpgsql security definer set search_path = core, public as $$
declare n core.numbering; yr int := extract(year from now())::int;
begin
  select * into n from core.numbering where kind = p_kind for update;
  if not found then raise exception 'no numbering series for %', p_kind; end if;

  if n.per_year and coalesce(n.last_year, 0) <> yr then
    update core.numbering set last_year = yr, last_value = 1 where kind = p_kind
      returning * into n;
  else
    update core.numbering set last_value = last_value + 1 where kind = p_kind
      returning * into n;
  end if;

  return n.prefix
       || case when n.per_year then yr::text || '-' else '' end
       || lpad(n.last_value::text, n.width, '0');
end $$;

comment on function core.next_number is
  'SELECT ... FOR UPDATE, so two people clicking at once cannot get INV-0007 twice.';


-- ═══ 5. PERMISSIONS ════════════════════════════════════════════════════════
-- Read for anyone signed in; writes belong to the tool that owns the row, so
-- they are granted per tool as each one ships. Nothing is opened to anon —
-- the ODM app ships the anon key in the browser.

alter table core.contacts  enable row level security;
alter table core.documents enable row level security;
alter table core.events    enable row level security;
alter table core.numbering enable row level security;

do $$
declare t text;
begin
  foreach t in array array['contacts','documents','events','numbering'] loop
    if not exists (select 1 from pg_policies
                   where schemaname='core' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on core.%I for select to authenticated using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

grant usage on schema core to authenticated;
grant select on all tables in schema core to authenticated;
grant execute on function core.next_number(text) to authenticated;
revoke execute on function core.emit(text,text,uuid,text,uuid,uuid,jsonb) from public;

-- Reminder: do NOT add `core` to Settings → API → Exposed schemas until a tool
-- genuinely needs it over PostgREST.
