-- ═══════════════════════════════════════════════════════════════════════════
-- bb — PMS Box Build. Manufacturing services.
--
-- Where ODM ends at 50–100 samples, Box Build takes a proven design and makes
-- it repeatedly, to a customer PO. So the shape of the data is different: not
-- tasks and stages, but a BOM, procurement against it, production runs, QC on
-- what came off the line, and dispatch.
--
-- Only projects ULM has sanctioned with kind = 'boxbuild' exist in this tool.
--
-- Requires: sanction-gate.sql, 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists bb;

create or replace view bb.projects
with (security_invoker = true) as
select * from core.visible('pms_bb');


-- ═══ THE ORDER ═════════════════════════════════════════════════════════════
create table if not exists bb.orders (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references core.projects(id) on delete set null,
  project_code text,
  org_id       uuid references core.orgs(id) on delete set null,
  po_ref       text,                            -- the customer's PO number
  po_date      date,
  qty          int not null check (qty > 0),
  qty_built    int not null default 0,
  qty_shipped  int not null default 0,
  unit_price   numeric(14,2),
  target_date  date,
  status       text not null default 'open'
                 check (status in ('open','in_production','on_hold','complete','cancelled')),
  document_id  uuid references core.documents(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists bb_orders_project_idx on bb.orders (project_id);
create index if not exists bb_orders_status_idx  on bb.orders (status, target_date);


-- ═══ THE BILL OF MATERIALS ═════════════════════════════════════════════════
-- Versioned, because the third revision of a BOM is a different thing from
-- the first and a run has to say which one it was built to.

create table if not exists bb.boms (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references core.projects(id) on delete set null,
  project_code text,
  name         text not null,
  revision     text not null default 'A',
  status       text not null default 'draft'
                 check (status in ('draft','released','superseded')),
  document_id  uuid references core.documents(id) on delete set null,
  released_at  timestamptz,
  released_by  uuid,
  created_at   timestamptz not null default now()
);
create unique index if not exists bb_boms_rev_idx on bb.boms (project_id, name, revision);

create table if not exists bb.bom_lines (
  id          uuid primary key default gen_random_uuid(),
  bom_id      uuid not null references bb.boms(id) on delete cascade,
  seq         int  not null default 0,
  ref_des     text,                              -- R1, C4, U2 …
  part_no     text not null,
  description text,
  manufacturer text,
  qty_per     numeric(12,3) not null default 1,
  uom         text not null default 'nos',
  unit_cost   numeric(14,4),
  critical    boolean not null default false,    -- long lead / single source
  alt_part_no text
);
create index if not exists bb_bom_lines_idx on bb.bom_lines (bom_id, seq);


-- ═══ PROCUREMENT — the part of manufacturing that actually slips ═══════════
create table if not exists bb.procurement (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references bb.orders(id) on delete cascade,
  bom_line_id  uuid references bb.bom_lines(id) on delete set null,
  part_no      text not null,
  vendor_id    uuid references core.orgs(id) on delete set null,
  qty_needed   numeric(12,3) not null,
  qty_ordered  numeric(12,3) not null default 0,
  qty_received numeric(12,3) not null default 0,
  unit_cost    numeric(14,4),
  po_ref       text,                              -- our PO to the vendor
  ordered_on   date,
  eta          date,
  received_on  date,
  status       text not null default 'to_order'
                 check (status in ('to_order','ordered','partial','received','shortage','cancelled')),
  note         text
);
create index if not exists bb_proc_order_idx  on bb.procurement (order_id, status);
create index if not exists bb_proc_eta_idx    on bb.procurement (eta) where status in ('ordered','partial');

-- What is short, right now, across every live order. The one query a Box
-- Build lead runs every morning.
create or replace view bb.shortages
with (security_invoker = true) as
select pr.*, o.project_code, o.target_date,
       (pr.qty_needed - pr.qty_received) as qty_short
from bb.procurement pr
join bb.orders o on o.id = pr.order_id
where o.status in ('open','in_production')
  and pr.qty_received < pr.qty_needed;


-- ═══ PRODUCTION ════════════════════════════════════════════════════════════
create table if not exists bb.runs (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references bb.orders(id) on delete cascade,
  bom_id       uuid references bb.boms(id) on delete set null,
  batch_no     text,
  qty_planned  int not null check (qty_planned > 0),
  qty_built    int not null default 0,
  qty_passed   int not null default 0,
  qty_failed   int not null default 0,
  started_on   date,
  finished_on  date,
  line         text,                              -- SMT / through-hole / assembly bay
  supervisor_id uuid,
  status       text not null default 'planned'
                 check (status in ('planned','running','paused','done','scrapped')),
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists bb_runs_order_idx on bb.runs (order_id, status);

create table if not exists bb.qc_checks (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references bb.runs(id) on delete cascade,
  stage       text not null,                     -- incoming | in_process | final | pre_dispatch
  checked_on  date not null default current_date,
  sample_size int,
  passed      int,
  failed      int,
  defects     jsonb not null default '[]'::jsonb,
  verdict     text not null default 'pending'
                check (verdict in ('pending','pass','fail','rework')),
  inspector_id uuid,
  document_id uuid references core.documents(id) on delete set null,
  note        text
);
create index if not exists bb_qc_run_idx on bb.qc_checks (run_id, stage);


-- ═══ DISPATCH ══════════════════════════════════════════════════════════════
create table if not exists bb.dispatches (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references bb.orders(id) on delete cascade,
  dc_no       text,                               -- core.next_number('dc')
  qty         int not null check (qty > 0),
  dispatched_on date,
  courier     text,
  awb         text,
  delivered_on date,
  document_id uuid references core.documents(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists bb_dispatch_order_idx on bb.dispatches (order_id);


-- ═══ WHAT BOX BUILD PUBLISHES ══════════════════════════════════════════════
-- Finance needs to know what has shipped in order to invoice it. It reads
-- this, not bb.dispatches.

create or replace view core.production_status
with (security_invoker = true) as
select o.project_id,
       o.project_code,
       o.id            as order_id,
       o.po_ref,
       o.qty,
       coalesce(sum(r.qty_built),  0)::int as qty_built,
       coalesce(sum(r.qty_passed), 0)::int as qty_passed,
       (select coalesce(sum(d.qty), 0)::int from bb.dispatches d where d.order_id = o.id) as qty_dispatched,
       o.status,
       o.target_date
from bb.orders o
left join bb.runs r on r.order_id = o.id
group by o.id, o.project_id, o.project_code, o.po_ref, o.qty, o.status, o.target_date;

comment on view core.production_status is
  'Box Build''s public face. Finance bills against this; it never reads bb.*.';


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['orders','boms','bom_lines','procurement','runs','qc_checks','dispatches'] loop
    execute format('alter table bb.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                   where schemaname='bb' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on bb.%I for select to authenticated using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

drop trigger if exists bb_orders_touch on bb.orders;
create trigger bb_orders_touch before update on bb.orders
  for each row execute function public.touch_updated_at();

grant usage on schema bb to authenticated;
grant select on all tables in schema bb to authenticated;
grant select on core.production_status to authenticated;
