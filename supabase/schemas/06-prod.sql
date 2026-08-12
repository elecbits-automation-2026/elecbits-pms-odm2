-- ═══════════════════════════════════════════════════════════════════════════
-- prod — PMS Product. SKD and CBU.
--
-- The other two tools deliver a project and stop. This one delivers a
-- CATALOGUE: a thing with a part number that exists after the project that
-- created it is closed, gets revised, gets stocked, and ships again next
-- quarter. So the centre of gravity is the SKU, not the project.
--
--   SKD — semi-knocked-down: shipped as a kit, assembled at the far end.
--   CBU — completely-built-up: shipped finished, and therefore serialised.
--
-- Requires: sanction-gate.sql, 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists prod;

create or replace view prod.projects
with (security_invoker = true) as
select * from core.visible('pms_product');


-- ═══ THE CATALOGUE ═════════════════════════════════════════════════════════
create table if not exists prod.skus (
  id           uuid primary key default gen_random_uuid(),
  sku_code     text unique not null,
  name         text not null,
  description  text,
  category     text,
  -- The project this came out of. Nullable and ON DELETE SET NULL on purpose:
  -- a product outlives the project that created it.
  project_id   uuid references core.projects(id) on delete set null,
  project_code text,
  status       text not null default 'development'
                 check (status in ('development','active','eol','withdrawn')),
  hsn_code     text,
  list_price   numeric(14,2),
  currency     text not null default 'INR',
  lead_time_days int,
  moq          int,
  owner_id     uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists prod_skus_status_idx on prod.skus (status, category);

create table if not exists prod.variants (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  variant_code text not null,
  label       text not null,                    -- '12V / WiFi / IP65'
  attributes  jsonb not null default '{}'::jsonb,
  price_delta numeric(14,2) not null default 0,
  active      boolean not null default true
);
create unique index if not exists prod_variants_code_idx on prod.variants (sku_id, variant_code);

-- What goes in the box, per SKU. A CBU ships one line: the finished unit. An
-- SKD ships many: the kit.
create table if not exists prod.kit_lines (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  variant_id  uuid references prod.variants(id) on delete cascade,
  seq         int  not null default 0,
  part_no     text not null,
  description text,
  qty         numeric(12,3) not null default 1,
  uom         text not null default 'nos',
  supplied_by text                              -- us | customer | third_party
);
create index if not exists prod_kit_lines_idx on prod.kit_lines (sku_id, seq);


-- ═══ BUILDS ════════════════════════════════════════════════════════════════
create table if not exists prod.builds (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  variant_id  uuid references prod.variants(id) on delete set null,
  project_id  uuid references core.projects(id) on delete set null,
  mode        text not null check (mode in ('skd','cbu')),
  batch_no    text,
  qty_planned int not null check (qty_planned > 0),
  qty_done    int not null default 0,
  started_on  date,
  finished_on date,
  status      text not null default 'planned'
                check (status in ('planned','running','done','cancelled')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists prod_builds_sku_idx on prod.builds (sku_id, status);

-- One physical unit. CBU only — you cannot serialise a kit that has not been
-- assembled yet. This is what a warranty claim is looked up by.
create table if not exists prod.units (
  id          uuid primary key default gen_random_uuid(),
  build_id    uuid references prod.builds(id) on delete set null,
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  serial_no   text unique not null,
  mac         text,
  firmware    text,
  built_on    date,
  qc_verdict  text check (qc_verdict is null or qc_verdict in ('pass','fail','rework')),
  status      text not null default 'in_stock'
                check (status in ('in_stock','shipped','installed','returned','scrapped')),
  shipped_on  date,
  warranty_until date,
  org_id      uuid references core.orgs(id) on delete set null
);
create index if not exists prod_units_sku_idx    on prod.units (sku_id, status);
create index if not exists prod_units_serial_idx on prod.units (serial_no);


-- ═══ STOCK AND SHIPPING ════════════════════════════════════════════════════
create table if not exists prod.stock (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  variant_id  uuid references prod.variants(id) on delete cascade,
  location    text not null default 'main',
  on_hand     numeric(12,3) not null default 0,
  allocated   numeric(12,3) not null default 0,
  available   numeric(12,3) generated always as (on_hand - allocated) stored,
  reorder_at  numeric(12,3),
  updated_at  timestamptz not null default now()
);
create unique index if not exists prod_stock_idx on prod.stock (sku_id, coalesce(variant_id, sku_id), location);

create table if not exists prod.stock_moves (
  id          bigserial primary key,
  sku_id      uuid not null references prod.skus(id) on delete cascade,
  variant_id  uuid references prod.variants(id) on delete set null,
  at          timestamptz not null default now(),
  qty         numeric(12,3) not null,          -- signed: +in, −out
  reason      text not null,                   -- build | shipment | return | adjust | scrap
  ref_id      uuid,
  location    text not null default 'main',
  by_id       uuid,
  note        text
);
create index if not exists prod_moves_sku_idx on prod.stock_moves (sku_id, at desc);

create table if not exists prod.shipments (
  id           uuid primary key default gen_random_uuid(),
  sku_id       uuid references prod.skus(id) on delete set null,
  org_id       uuid references core.orgs(id) on delete set null,
  project_id   uuid references core.projects(id) on delete set null,
  mode         text check (mode is null or mode in ('skd','cbu')),
  qty          int not null check (qty > 0),
  dc_no        text,
  shipped_on   date,
  courier      text,
  awb          text,
  delivered_on date,
  document_id  uuid references core.documents(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists prod_shipments_org_idx on prod.shipments (org_id, shipped_on desc);


-- ═══ WHAT PRODUCT PUBLISHES ════════════════════════════════════════════════
create or replace view core.catalogue
with (security_invoker = true) as
select s.id as sku_id, s.sku_code, s.name, s.category, s.status,
       s.list_price, s.currency, s.project_id, s.project_code,
       coalesce(sum(st.on_hand),   0) as on_hand,
       coalesce(sum(st.available), 0) as available,
       (select count(*) from prod.units u where u.sku_id = s.id and u.status = 'in_stock') as units_in_stock
from prod.skus s
left join prod.stock st on st.sku_id = s.id
group by s.id;

comment on view core.catalogue is
  'The Product tool''s public face — what exists, what is in stock, what it '
  'costs. Sales quotes against this; Finance values inventory from it.';


-- ═══ PERMISSIONS ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['skus','variants','kit_lines','builds','units','stock','stock_moves','shipments'] loop
    execute format('alter table prod.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                   where schemaname='prod' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on prod.%I for select to authenticated using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

drop trigger if exists prod_skus_touch on prod.skus;
create trigger prod_skus_touch before update on prod.skus
  for each row execute function public.touch_updated_at();

grant usage on schema prod to authenticated;
grant select on all tables in schema prod to authenticated;
grant select on core.catalogue to authenticated;
