# The eight schemas

One database. One project spine. Eight namespaces, one per tool. Nothing left
in `public` but a handful of shared functions.

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

---

## What to run

Everything up to `plan-and-stages.sql` is already applied to the live
database. This is what is left, in order. Every file is idempotent — re-running
one changes nothing.

| Step | Run | What it does |
|---|---|---|
| 1 | `../harden-the-mirror.sql` | drops 12 profile FKs and 3 not-null dates that can freeze a whole table's sync |
| 2 | `../go-live.sql` | drops dead columns left over from superseded designs |
| 3 | **`00-one-structure.sql`** | **moves all 19 tables out of `public` into `core` and `pms`** |
| 4 | *Settings → API → Exposed schemas:* add `core` and `pms` | so PostgREST can see them |
| 5 | **Redeploy Vercel** | the app addresses the new names |
| 6 | `../sanction-gate.sql` | sanction state on `core.projects`, `core.tools/staffing/visible`, `ulm.decide()` |
| 7 | `01-core.sql` | `core.orgs` columns, contacts, documents, events, numbering |
| 8 | `02-sales.sql` | leads, quotes, requests → publishes `core.intake` |
| 9 | `03-ulm.sql` | reviews, risks, resource plan, `ulm.accept_request()` |
| 10 | `04-pms-odm.sql` | ODM's project window → publishes `core.delivery_status` |
| 11 | `05-bb.sql` | Box Build → publishes `core.production_status` |
| 12 | `06-prod.sql` | Product → publishes `core.catalogue` |
| 13 | `07-hr.sql` | HR (admin-only policies) |
| 14 | `08-fin.sql` | Finance → publishes `core.financial_status` |
| 15 | `09-hr-tool.sql` | the HR tool: **moves the daily record (`pms.kpi_log`, `pms.work_updates`) into `core`**, adds 15 `hr` tables, ships `hr.is_hr()` unused |

Steps 10–14 are independent of each other. Only 3 → 6 → 7 → 8 → 9 is a real
chain. Step 15 needs 13 (`07-hr.sql`) first, and like step 3 it moves live
tables: deploy an ODM build that carries the three-era `src/lib/tables.js`
before running it, or the app addresses `kpi_log` and `work_updates` at their
old home and cannot find the new one.

### Steps 3–5 are a cutover — do them back to back

`ALTER TABLE … SET SCHEMA` is metadata-only: no row is copied, no index is
rebuilt, and there is no half-migrated state to recover from. Policies, grants,
indexes, constraints, triggers and owned sequences all travel with the table.

But the deployed app addresses tables by name, so between step 3 and step 5 it
cannot save. Its data is not at risk — nothing is deleted and nothing is
copied — but **do not run step 3 mid-edit.** Run it, add the exposed schemas,
hit Redeploy. Minutes, not hours.

Steps 6–14 add new objects only and are safe to run at any pace afterwards.

**If step 3 goes wrong, `00-rollback.sql` puts everything back.** It is the
exact inverse of the move — verified to restore the same 19 tables, 24
policies, 58 indexes, 4 foreign keys and byte-identical data — and the old app
works again the moment it finishes. It refuses to run once step 7 has given
`core` tables of its own, because past that point the way back is a backup
restore, not a script. Have it open in a tab before you start step 3.

---

## The final table list

### `core` — 12 tables, what the whole company shares

| Table | Was | One row is |
|---|---|---|
| `people` | `public.profiles` | a person on the roster |
| `orgs` | `public.clients` | a customer, vendor or partner |
| `projects` | `public.projects` | **the spine** — every project, every tool |
| `assignments` | `public.team_assignments` | a person in a slot on a project |
| `trainings` | `public.trainings` | a training assigned to someone |
| `memory` | `public.memory` | a pgvector memory |
| `sync_log` | `public.drive_sync_log` | a Drive sync run |
| `tools` | new | one of the eight tools + its routing rule |
| `contacts` | new | a named human at an org |
| `documents` | new | a file, wherever it lives in Drive |
| `events` | new | one thing that happened, for other tools to react to |
| `numbering` | new | a document number series |

Views: `staffing`, `intake`, `delivery_status`, `production_status`,
`catalogue`, `financial_status`. Functions: `visible(tool)`, `emit()`,
`next_number()`.

### `pms` — 12 tables, the ODM tool's own

| Table | Was |
|---|---|
| `workspace` | `public.app_kv` |
| `tasks` | `public.tasks` |
| `stages` | `public.project_stages` |
| `scrum_notes` | `public.scrum_notes` (`by` → `author_id`) |
| `meetings` | `public.moms` |
| `meeting_ideas` / `_decisions` / `_challenges` | `public.mom_*` |
| `messages` | `public.messages` |
| `intel` | `public.project_intel` |
| `work_updates` | `public.work_updates` |
| `kpi_log` | `public.kpi_log` |

Views: `projects` (sanctioned ODM only), `team`.

`work_updates` and `kpi_log` move on to `core` at step 15 — the daily record
was never this tool's alone, and the HR tool reads it there without breaking
the one rule.

### The five tools still to be built

| Schema | Tables |
|---|---|
| `sales` (5) | `leads`, `activities`, `quotes`, `quote_lines`, `requests` |
| `ulm` (6) | `sanction_events`, `allocations`, `work_packages`, `reviews`, `risks`, `resource_plan` |
| `bb` (7) | `orders`, `boms`, `bom_lines`, `procurement`, `runs`, `qc_checks`, `dispatches` |
| `prod` (8) | `skus`, `variants`, `kit_lines`, `builds`, `units`, `stock`, `stock_moves`, `shipments` |
| `hr` (13) | `employees`, `compensation`, `attendance`, `leave_types`, `leave_requests`, `leave_balances`, `review_cycles`, `appraisals`, `goals`, `payroll_runs`, `payslips`, `openings`, `candidates` — **built**: `09-hr-tool.sql` takes it to 28 tables + a view; the app lives in the `elecbits-hr-tool` repo |
| `fin` (9) | `budgets`, `milestones`, `purchase_orders`, `po_lines`, `expenses`, `invoices`, `invoice_lines`, `payments`, `cost_entries` |

**72 tables, 15 views, 8 schemas.** `public` keeps only shared functions:
`is_admin()`, `touch_updated_at()`, `handle_new_user()`, `match_memory()`, and
the two triggers guarding sanction state.

---

## What this does NOT do

**Nothing is exposed to the browser beyond `core` and `pms`.** The other six
schemas stay out of Exposed schemas, and nothing is granted to `anon` — the app
ships the anon key in its bundle and signs in before it reads anything. `hr`
and `fin` go further: their read policies are `public.is_admin()`, not "any
signed-in user", with a per-row exception so a person can see their own
employee record, leave and payslips.

**Nothing decides on its own.** `ulm.decide()` is the only writer of sanction
state, and `fin.require_sanction()` refuses money against a project ULM has not
sanctioned.

## Verified

Against real Postgres 16, from an empty database: all fifteen files run clean
and are idempotent, and `public` ends with zero tables and zero views.

- The mirror's exact upsert still succeeds against every moved table.
- All 17 sync jobs resolve to `core.*` or `pms.*`; **nothing reaches `public`**,
  and an old name like `profiles` throws rather than silently falling through.
- One end-to-end pass — lead → quote → request → `ulm.accept_request()` →
  project sanctioned as `boxbuild` → BOM, procurement, run, QC, dispatch →
  budget, invoice, cost → un-sanction — routes to exactly one delivery tool,
  refuses a PO before sanction, keeps HR's project feed empty while
  `hr.utilisation` still resolves the person, and leaves every order and
  invoice intact after the un-sanction.
