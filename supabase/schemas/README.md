# The eight schemas

One database. One project spine. Eight namespaces, one per tool.

```
                              sales
                                │  raises a request
                                ▼
                              ulm ──── sanctions & routes ────┐
                                                              │
        ┌──────────────┬──────────────┬──────────────┬────────┴─────┐
        ▼              ▼              ▼              ▼              ▼
      pms            bb            prod            fin            hr
   (ODM, built)  (box build)     (product)       (money)        (people)
        └──────────────┴──────────────┴──────────────┴──────────────┘
                                │  all of them read
                                ▼
                              core
```

**The one rule: every tool reads `core`. No tool ever reads another tool's
schema.** When two tools need to talk, it happens one of three ways and no
other:

| Direction | Mechanism | Example |
|---|---|---|
| Outward | a view published into `core` | `core.production_status` — Box Build tells Finance what shipped |
| Inward | a `SECURITY DEFINER` function the owning schema exposes | `sales.settle_request()` — ULM closes a Sales request without touching its table |
| Broadcast | `core.emit()` → `core.events` | anything anyone might want to react to |

## Run order

Run each file once, in this order, in the Supabase SQL editor. Every file is
idempotent — re-running one changes nothing.

| # | File | Creates |
|---|---|---|
| 0 | `../sanction-gate.sql` | the gate: sanction state on `public.projects`, `core.tools/projects/people/staffing/visible`, `ulm.sanction_events/allocations/work_packages/decide()` |
| 1 | `01-core.sql` | `core.orgs`, `contacts`, `documents`, `events`, `numbering`, `emit()`, `next_number()` |
| 2 | `02-sales.sql` | `sales.leads`, `activities`, `quotes`, `quote_lines`, `requests` → publishes `core.intake` |
| 3 | `03-ulm.sql` | `ulm.reviews`, `risks`, `resource_plan`, `load`, `accept_request()` |
| 4 | `04-pms-odm.sql` | `pms.*` — views only, over the ODM app's existing `public` tables → publishes `core.delivery_status` |
| 5 | `05-bb.sql` | `bb.orders`, `boms`, `bom_lines`, `procurement`, `runs`, `qc_checks`, `dispatches` → publishes `core.production_status` |
| 6 | `06-prod.sql` | `prod.skus`, `variants`, `kit_lines`, `builds`, `units`, `stock`, `stock_moves`, `shipments` → publishes `core.catalogue` |
| 7 | `07-hr.sql` | `hr.employees`, `compensation`, `attendance`, `leave_*`, `appraisals`, `goals`, `payroll_runs`, `payslips`, `openings`, `candidates`, `utilisation` |
| 8 | `08-fin.sql` | `fin.budgets`, `milestones`, `purchase_orders`, `po_lines`, `expenses`, `invoices`, `invoice_lines`, `payments`, `cost_entries`, `project_pl` → publishes `core.financial_status` |

Files 4–8 are independent of each other; only 0 → 1 → 2 → 3 is a real chain.

## What this does NOT do

**Nothing here touches the running ODM app.** `pms` creates no tables — it is
a namespace of views over `public`, which the app keeps writing through its
mirror exactly as before. `core.orgs` is a view over `public.clients`. The
only DDL against an existing table is added, nullable columns.

**Nothing is exposed to the browser.** None of these schemas are in
Settings → API → Exposed schemas, and none are granted to `anon` — the ODM app
ships the anon key in its bundle. `hr` and `fin` go further: their read
policies are `public.is_admin()`, not "any signed-in user", with a per-row
exception so a person can see their own employee record, leave and payslips.

**Nothing decides on its own.** `ulm.decide()` is still the only writer of
sanction state, and `fin.require_sanction()` refuses money against a project
ULM has not sanctioned.

## Verified

Against real Postgres 16, from an empty database: all fourteen files run clean
and are idempotent; the ODM mirror's exact upsert still succeeds with
everything installed; and one end-to-end pass — lead → quote → request →
`ulm.accept_request()` → project sanctioned as `boxbuild` → BOM, procurement,
run, QC, dispatch → budget, invoice, cost → un-sanction — routes to exactly
one delivery tool, refuses a PO before sanction, keeps HR's project feed empty
while `hr.utilisation` still resolves the person, and leaves every order and
invoice intact after the un-sanction.
