-- ═══════════════════════════════════════════════════════════════════════════
-- fin — money. The one tool with a direct, unavoidable relation to projects.
--
-- Every row here names a project, because that is what money attaches to: a
-- budget for it, a PO against it, an invoice out of it, a cost booked to it.
-- And none of them may exist before ULM sanctions it — that is the rule the
-- sanction gate was built to enforce, and it is enforced here, in the
-- database, not in a form.
--
-- Finance sees closed projects too: the last invoice always lands after
-- delivery, and nobody may hide a cost by closing a project.
--
-- Requires: sanction-gate.sql, 01-core.sql
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists fin;

create or replace view fin.projects
with (security_invoker = true) as
select * from core.visible('finance');


-- ═══ THE RULE — no money before a sanction ═════════════════════════════════
create or replace function fin.require_sanction() returns trigger
language plpgsql as $$
declare st text;
begin
  if new.project_id is null then return new; end if;   -- overheads have no project
  select sanction_state into st from public.projects where id = new.project_id;
  if st is null then
    raise exception 'no such project: %', new.project_id;
  end if;
  if st in ('draft','requested') then
    raise exception 'project % is not sanctioned yet (%): money cannot be committed to it',
      (select project_id from public.projects where id = new.project_id), st
      using errcode = '42501';
  end if;
  return new;
end $$;

comment on function fin.require_sanction is
  'Attached to every table below that carries a project. A PO against an '
  'un-sanctioned project is refused by the database, not by a form.';


-- ═══ BUDGET ════════════════════════════════════════════════════════════════
create table if not exists fin.budgets (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  version      int not null default 1,
  currency     text not null default 'INR',
  revenue      numeric(14,2) not null default 0,
  cost_material numeric(14,2) not null default 0,
  cost_labour  numeric(14,2) not null default 0,
  cost_other   numeric(14,2) not null default 0,
  budget_total numeric(14,2) generated always as
                 (cost_material + cost_labour + cost_other) stored,
  margin_pct   numeric(5,2),
  approved_by  uuid,
  approved_at  timestamptz,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists fin_budgets_project_idx on fin.budgets (project_id, version desc);

-- Payment milestones — what may be invoiced, and when it becomes billable.
create table if not exists fin.milestones (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  seq          int not null default 0,
  title        text not null,                 -- 'Design freeze', 'On dispatch'
  trigger_kind text not null default 'manual'
                 check (trigger_kind in ('manual','stage_done','dispatch','date')),
  trigger_ref  text,                          -- the stage id / date it keys off
  amount       numeric(14,2) not null default 0,
  pct          numeric(5,2),
  due_on       date,
  status       text not null default 'pending'
                 check (status in ('pending','billable','invoiced','paid','waived')),
  invoice_id   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists fin_milestones_project_idx on fin.milestones (project_id, seq);


-- ═══ MONEY OUT ═════════════════════════════════════════════════════════════
create table if not exists fin.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  po_no        text unique,                   -- core.next_number('po')
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  vendor_id    uuid references public.clients(id) on delete set null,
  po_date      date not null default current_date,
  currency     text not null default 'INR',
  subtotal     numeric(14,2) not null default 0,
  tax          numeric(14,2) not null default 0,
  total        numeric(14,2) not null default 0,
  status       text not null default 'draft'
                 check (status in ('draft','approved','sent','partial','received','closed','cancelled')),
  expected_on  date,
  approved_by  uuid,
  document_id  uuid references core.documents(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists fin_po_project_idx on fin.purchase_orders (project_id);
create index if not exists fin_po_vendor_idx  on fin.purchase_orders (vendor_id, status);

create table if not exists fin.po_lines (
  id          uuid primary key default gen_random_uuid(),
  po_id       uuid not null references fin.purchase_orders(id) on delete cascade,
  seq         int  not null default 0,
  item        text not null,
  part_no     text,
  qty         numeric(12,3) not null default 1,
  uom         text not null default 'nos',
  rate        numeric(14,4) not null default 0,
  amount      numeric(14,2) generated always as (round(qty * rate, 2)) stored,
  qty_received numeric(12,3) not null default 0
);
create index if not exists fin_po_lines_idx on fin.po_lines (po_id, seq);

create table if not exists fin.expenses (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  person_id    uuid,
  date         date not null default current_date,
  category     text not null,                 -- travel | courier | tooling | sample | misc
  description  text,
  amount       numeric(14,2) not null,
  billable     boolean not null default false,
  status       text not null default 'submitted'
                 check (status in ('submitted','approved','rejected','reimbursed')),
  document_id  uuid references core.documents(id) on delete set null,
  approved_by  uuid,
  created_at   timestamptz not null default now()
);
create index if not exists fin_expenses_project_idx on fin.expenses (project_id, date desc);


-- ═══ MONEY IN ══════════════════════════════════════════════════════════════
create table if not exists fin.invoices (
  id           uuid primary key default gen_random_uuid(),
  invoice_no   text unique,                   -- core.next_number('invoice')
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  org_id       uuid references public.clients(id) on delete set null,
  milestone_id uuid references fin.milestones(id) on delete set null,
  invoice_date date not null default current_date,
  due_date     date,
  currency     text not null default 'INR',
  subtotal     numeric(14,2) not null default 0,
  tax_pct      numeric(5,2)  not null default 18,
  tax          numeric(14,2) not null default 0,
  total        numeric(14,2) not null default 0,
  paid         numeric(14,2) not null default 0,
  outstanding  numeric(14,2) generated always as (total - paid) stored,
  status       text not null default 'draft'
                 check (status in ('draft','sent','part_paid','paid','overdue','cancelled')),
  document_id  uuid references core.documents(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists fin_invoices_project_idx on fin.invoices (project_id);
create index if not exists fin_invoices_due_idx     on fin.invoices (due_date)
  where status in ('sent','part_paid','overdue');

create table if not exists fin.invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references fin.invoices(id) on delete cascade,
  seq         int  not null default 0,
  item        text not null,
  hsn_sac     text,
  qty         numeric(12,3) not null default 1,
  uom         text not null default 'nos',
  rate        numeric(14,4) not null default 0,
  amount      numeric(14,2) generated always as (round(qty * rate, 2)) stored
);
create index if not exists fin_invoice_lines_idx on fin.invoice_lines (invoice_id, seq);

create table if not exists fin.payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid references fin.invoices(id) on delete set null,
  po_id       uuid references fin.purchase_orders(id) on delete set null,
  direction   text not null check (direction in ('in','out')),
  amount      numeric(14,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  method      text,                            -- neft | upi | cheque | card
  reference   text,
  tds         numeric(14,2) not null default 0,
  note        text,
  recorded_by uuid,
  created_at  timestamptz not null default now()
);
create index if not exists fin_payments_invoice_idx on fin.payments (invoice_id);


-- ═══ COST BOOKED TO A PROJECT ══════════════════════════════════════════════
-- Material comes from POs, labour from effort. This is the ledger the P&L per
-- project is built from.

create table if not exists fin.cost_entries (
  id           bigserial primary key,
  project_id   uuid references public.projects(id) on delete set null,
  project_code text,
  at           timestamptz not null default now(),
  kind         text not null check (kind in ('material','labour','expense','overhead','adjust')),
  source       text,                           -- 'fin.po_lines' | 'core.staffing' | 'manual'
  source_id    uuid,
  person_id    uuid,
  hours        numeric(8,2),
  rate         numeric(14,2),
  amount       numeric(14,2) not null,
  note         text
);
create index if not exists fin_cost_project_idx on fin.cost_entries (project_id, kind);


-- ═══ THE ANSWER FINANCE EXISTS TO GIVE ═════════════════════════════════════
create or replace view fin.project_pl
with (security_invoker = true) as
select
  p.id                as project_id,
  p.project_id        as project_code,
  p.name,
  p.kind,
  p.sanction_state,
  b.budget_total,
  b.revenue           as budgeted_revenue,
  coalesce(i.invoiced, 0)  as invoiced,
  coalesce(i.received, 0)  as received,
  coalesce(c.cost, 0)      as cost_booked,
  coalesce(i.invoiced, 0) - coalesce(c.cost, 0) as margin,
  case when coalesce(i.invoiced, 0) > 0
       then round((coalesce(i.invoiced,0) - coalesce(c.cost,0)) / i.invoiced * 100, 2)
  end                      as margin_pct
from public.projects p
left join lateral (
  select budget_total, revenue from fin.budgets b2
  where b2.project_id = p.id order by version desc limit 1
) b on true
left join lateral (
  select sum(total) as invoiced, sum(paid) as received
  from fin.invoices iv where iv.project_id = p.id and iv.status <> 'cancelled'
) i on true
left join lateral (
  select sum(amount) as cost from fin.cost_entries ce where ce.project_id = p.id
) c on true
where p.sanction_state <> 'draft';

comment on view fin.project_pl is
  'Budget vs invoiced vs cost, per project. The one screen the CEO opens.';

-- What Finance publishes back: whether a project is clear to keep spending.
create or replace view core.financial_status
with (security_invoker = true) as
select project_id, project_code, budget_total, invoiced, received, cost_booked, margin_pct,
       case
         when budget_total is null                  then 'no_budget'
         when cost_booked > budget_total            then 'over_budget'
         when cost_booked > budget_total * 0.85     then 'watch'
         else 'ok'
       end as budget_state
from fin.project_pl;

comment on view core.financial_status is
  'Finance''s public face. ULM and the PMS tools read this; they never read fin.*.';


-- ═══ ENFORCEMENT AND PERMISSIONS ═══════════════════════════════════════════
do $$
declare t text;
begin
  -- The sanction rule, on every table that names a project.
  foreach t in array array['budgets','milestones','purchase_orders','expenses',
                           'invoices','cost_entries'] loop
    execute format('drop trigger if exists %I on fin.%I', t||'_sanctioned', t);
    execute format(
      'create trigger %I before insert or update of project_id on fin.%I
         for each row execute function fin.require_sanction()', t||'_sanctioned', t);
  end loop;

  -- Money is admin-only, like HR. No blanket authenticated read.
  foreach t in array array['budgets','milestones','purchase_orders','po_lines','expenses',
                           'invoices','invoice_lines','payments','cost_entries'] loop
    execute format('alter table fin.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                   where schemaname='fin' and tablename=t and policyname=t||'_admin') then
      execute format(
        'create policy %I on fin.%I for select to authenticated using (public.is_admin())',
        t||'_admin', t);
    end if;
  end loop;
end $$;

drop trigger if exists fin_po_touch on fin.purchase_orders;
create trigger fin_po_touch before update on fin.purchase_orders
  for each row execute function public.touch_updated_at();
drop trigger if exists fin_inv_touch on fin.invoices;
create trigger fin_inv_touch before update on fin.invoices
  for each row execute function public.touch_updated_at();

grant usage on schema fin to authenticated;
grant select on all tables in schema fin to authenticated;  -- RLS above decides
grant select on core.financial_status to authenticated;
