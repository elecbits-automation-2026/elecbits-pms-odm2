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

### Integration seams (swap these for real services in production)

| Seam | Today | In production |
| --- | --- | --- |
| **Persistence** — `window.storage` | localStorage shim in `main.jsx` | Supabase / your backend |
| **AI** — `claude()` in `App.jsx` | Anthropic Messages API, offline fallback | your key-holding proxy |
| **Drive / Sheets** — `sheetSync()` | visible entries in the **Sync Log** | Drive/Sheets edge functions |

None of these block the flow — the app is fully usable without any of them
wired up.

---

## Configuration

Copy `.env.example` to `.env` and set what you need (see the file for details):

- `VITE_CLAUDE_PROXY_URL` — **recommended**: your backend proxy that holds the
  API key server-side and forwards to Anthropic. Keeps the key out of the
  browser.
- `VITE_ANTHROPIC_API_KEY` — **local dev only**: calls Anthropic directly from
  the browser (exposes the key — never ship this).
- `VITE_CLAUDE_MODEL` — model for all AI calls (default `claude-sonnet-4-5`).

With nothing set, every AI feature falls back to a deterministic offline parser
and the app still works — you just don't get live Claude quality.
