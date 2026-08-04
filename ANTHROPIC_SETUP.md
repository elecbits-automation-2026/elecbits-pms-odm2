# Attach the Anthropic API — live Claude in every AI window

This turns the four AI windows — Daily-Scrum **Organise**, Create-Project
**Designer LLD**, Complete-Now **verification**, Work-update **KPI scoring** —
from their offline fallbacks into **real Claude**. No code change; just keys.

> Right now those windows run heuristic offline parsers because the browser has
> no API key. Below are **three ways** to fix that — two need **no terminal /
> no CLI** at all. Pick one.

---

## First: get an Anthropic API key (needed for every path)

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. **Settings → API Keys → Create Key**. Copy it (`sk-ant-...`).
3. Add some credit under **Billing** (calls cost money).

---

## Path A — no CLI, no Supabase, ~2 minutes ✅ easiest

Put the key straight into the app via Vercel. Works immediately, no proxy.

1. **Vercel → your project → Settings → Environment Variables → Add:**

   | Name | Value |
   | --- | --- |
   | `VITE_ANTHROPIC_API_KEY` | `sk-ant-...` |

2. **Deployments → ⋯ → Redeploy.**
3. Open the app → Daily Scrum → **Organise with AI**. If the pill says
   “AI organised” (not “Offline parse”), Claude is live — in all four windows.

**Trade-off:** the key ships inside the browser bundle, so anyone who inspects
the site can read it. Fine for a private/internal tool — just rotate the key if
it leaks, and move to Path B before anything public. **No Supabase needed for
this.**

---

## Path B — no CLI, secure (deploy the proxy from the Supabase dashboard)

Same safety as the CLI route (key stays server-side) but done entirely in the
browser. Requires a Supabase project.

1. Supabase project → **Edge Functions** (left sidebar) → **Create a function**
   → choose the in-browser **editor**.
2. Name it **`claude`**.
3. Open [`supabase/functions/claude/index.ts`](supabase/functions/claude/index.ts)
   from this repo, copy the whole file, and paste it into the editor
   (replace the sample code). Click **Deploy**.
4. In that function's **Settings**, turn **Verify JWT** *off* — the app calls it
   without a login token. (Default is on.)
5. Add the secret: **Project Settings → Edge Functions → Add new secret**
   (or the function’s **Secrets** tab):
   `ANTHROPIC_API_KEY` = `sk-ant-...`  *(optional: `CLAUDE_MODEL` = `claude-sonnet-4-5`)*.
6. Copy the function URL shown in the dashboard — it looks like
   `https://<your-ref>.functions.supabase.co/claude`.
7. **Vercel → Settings → Environment Variables → Add:**
   `VITE_CLAUDE_PROXY_URL` = that URL. Then **Redeploy**.
8. Verify the same way (Daily Scrum → Organise with AI).

---

## Path C — the CLI route (only if you prefer a terminal)

```bash
npm i -g supabase && supabase login
supabase link --project-ref <your-ref>
supabase functions deploy claude
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxx
```
Then set `VITE_CLAUDE_PROXY_URL=https://<ref>.functions.supabase.co/claude` in
Vercel and redeploy. (The `config.toml` in this repo already turns off JWT
verification for the function, so with the CLI you skip step B-4.)

---

## Which should I pick?

| | CLI needed | Supabase needed | Key hidden | Speed |
| --- | :---: | :---: | :---: | :---: |
| **Path A** (direct key) | ✗ | ✗ | ✗ | fastest |
| **Path B** (dashboard proxy) | ✗ | ✓ | ✓ | medium |
| **Path C** (CLI proxy) | ✓ | ✓ | ✓ | medium |

Start with **Path A** to see it working today; switch to **Path B** when you
want the key off the browser. Both are 100% dashboard — no terminal.

---

### Troubleshooting

- **Still “Offline parse”:** the env var isn’t in the build — confirm it’s set
  for the right Vercel environment and that you **redeployed** after adding it.
- **Path B returns `ANTHROPIC_API_KEY not set`:** add the secret in the
  dashboard, then re-deploy the function (Deploy again).
- **Path B returns 401 “Invalid JWT”:** you didn’t turn off **Verify JWT** for
  the function (step B-4).
- **`credit balance is too low`:** add credit in the Anthropic console → Billing.
