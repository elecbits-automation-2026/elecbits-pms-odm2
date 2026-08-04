# Elecbits ODM — Project Management System

A single-page management system for Elecbits' ODM (Original Design Manufacturing)
pipeline. One app, a left sidebar, role-based views, and AI woven through every
module. Data persists across sessions; every Google Drive / Sheets / Supabase
write is surfaced as a visible **integration seam** so the flow is complete
today and obviously wireable into the real backend tomorrow.

> Built with React + Vite. All AI features run on Claude and **degrade
> gracefully to offline parsers** when no AI endpoint is configured — so the
> whole app runs end-to-end with zero setup.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # production bundle in dist/
npm run preview  # serve the built bundle
```

Open the app and use the **“Viewing as”** switcher (top-right) to demo each
role — Admin, Dept Head (Shreya), PM (Akshay), and engineers (Rahul / Gargi /
Nikhil). It boots with a seeded project **`ESP32-123`** so every module works
immediately.

---

## The five modules

1. **Create a Project** *(admin only)* — a chat-style wizard: client lookup →
   Client ID (industry + org-size codes) → contact → project name + deadline →
   Project ID → team allocation → Customer LLD → Designer LLD → review.
   Three **hard gates** — Project ID, Customer LLD and Designer LLD — each offer
   an **auto/AI path *and* a manual path**, and the *Create* button stays locked
   until Project ID, both LLDs, a PM and a deadline are all green. No execution
   here: project + status only. Below the button, the live projects list with
   status pills, deadline countdowns and assigned team.

2. **Daily Scrum** — date-wise notes; every save is Note 1, Note 2… timestamped.
   Write free text (“project ID esp-32-123, check gerber, rahul 12–1pm, if gerber
   fails → verify schematic + submit report in 1h…”), hit **Organise with AI**,
   and it splits into assigned, time-boxed tasks with `if/else` contingencies
   rendered on a branch rail, then pushes them into the task system with ticking
   clocks.

3. **My Projects & Tasks** — group **by project** or **by person**; filter by
   human and project. Admin sees everything; an engineer sees only theirs. Task
   lifecycle: **Start → work window** (what was done, file name + Drive path
   demanded) → **Complete Now → AI verification interview** (pointed questions;
   weak answers keep the task open with feedback). Stuck work **branches into
   sub-tasks** that write an auto *story* back into today's scrum. An **“Escalate
   to Shreya?”** checkbox sits on every closure and is tracked (fewer = better).

4. **Performance & Training** — a side-to-side tab menu (**KPI tracking · Work
   update sheet · Training**) with a shared calendar. Per-PM daily KPIs with a
   **red-alert** banner when a day dips below threshold. The Work Update sheet is
   a Google-Docs-style open-ended daily page; on submit, AI scores how well it
   aligns with the KPIs and stores the score with that day's entry. Managers also
   get a person × day team grid.

5. **System Memory** *(admin)* — paste templates, instruction sets, previous
   Claude conversations and Drive sitemaps (Project-ID / PCB-ID folders), or
   upload a doc. Everything here is **injected into every AI call** (scrum
   parsing, task verification, KPI scoring, designer-LLD generation) — this is
   how the system gets smarter over time. Also hosts the Sync Log and a reset.

---

## Architecture

Everything lives in **`src/App.jsx`** — a self-contained React app (state via
hooks + context, styling via an injected `<style>` block with a light/dark
theme). `src/main.jsx` mounts it and installs the two seams below.

```
src/
  App.jsx     # the whole app: 5 modules, wizard, AI layer, theme
  main.jsx    # React root + the window.storage → localStorage shim
  index.css   # minimal first-paint base (App injects its full theme at runtime)
```

### Integrations (built — supply your keys to turn them on)

Three real integrations ship in this repo. Each is **off by default and degrades
gracefully**, so the app runs end-to-end with zero config; set the matching env
vars to switch each one on.

| Integration | Code | Off (default) | On |
| --- | --- | --- | --- |
| **Supabase DB** | `src/lib/supabase.js`, `main.jsx`, `supabase/schema.sql` | localStorage | cloud persistence via the `app_kv` table |
| **Anthropic (AI)** | `supabase/functions/claude/` | offline parsers | live Claude, key held server-side |
| **Google Drive/Sheets** | `supabase/functions/drive-sync/` | local Sync Log | writes each event to a Google Sheet + `drive_sync_log` |

The backend for the AI and Drive integrations is **Supabase Edge Functions** —
one Supabase project hosts the database *and* the two key-holding functions.

---

## Turn on the live services

### 1. Supabase database

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL editor** → paste and run [`supabase/schema.sql`](supabase/schema.sql).
3. **Settings → API** → copy the Project URL and the `anon` public key into
   `.env` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

The app now persists to Postgres (shared team state) instead of localStorage.

### 2. Anthropic — live Claude in all four AI windows

The four AI windows are Daily-Scrum *Organise*, Create-Project *Designer LLD*,
Complete-Now *verification*, and Work-update *scoring*. Enable real Claude with
the server-side proxy (recommended — the key never touches the browser):

```bash
npm i -g supabase                      # once
supabase link --project-ref <your-ref>
supabase functions deploy claude
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # optionally CLAUDE_MODEL=...
```

Then set `VITE_CLAUDE_PROXY_URL=https://<ref>.functions.supabase.co/claude` in
your `.env` (and in your Vercel project's env vars) and redeploy.

> For a quick local-only test you can instead set `VITE_ANTHROPIC_API_KEY` — but
> that exposes the key in the browser bundle, so never ship it.

### 3. Google Drive / Sheets

1. In Google Cloud: create a **service account**, enable the **Google Sheets
   API**, and download its JSON key.
2. Create a Google Sheet, add a `SyncLog` tab, and **share it with the service-
   account email** as an Editor.
3. Deploy and configure the function:

   ```bash
   supabase functions deploy drive-sync
   supabase secrets set \
     GOOGLE_SERVICE_ACCOUNT_EMAIL="svc@project.iam.gserviceaccount.com" \
     GOOGLE_PRIVATE_KEY="$(cat key.json | jq -r .private_key)" \
     GOOGLE_SHEET_ID="<spreadsheet id>"
   ```

4. Set `VITE_DRIVE_SYNC_URL=https://<ref>.functions.supabase.co/drive-sync`.

Every project create, scrum push and task closure then appends a row to your
Sheet and is recorded in `drive_sync_log`.

See [`.env.example`](.env.example) for the full list of variables.
