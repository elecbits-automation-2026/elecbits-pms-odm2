# Attach the Anthropic API — live Claude in every AI window

This turns the four AI windows — Daily-Scrum **Organise**, Create-Project
**Designer LLD**, Complete-Now **verification**, Work-update **KPI scoring** —
from their offline fallbacks into **real Claude**. No code change; it's a key +
one function deploy.

> Right now those windows run heuristic offline parsers because the browser has
> no API key. The secure fix is a tiny **proxy** (already coded at
> `supabase/functions/claude/`) that holds the key server-side. You should have
> Supabase attached first (see `SUPABASE_SETUP.md`) — the proxy lives there.

---

## 1. Get an Anthropic API key

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. **Settings → API Keys → Create Key**. Copy it (`sk-ant-...`) — you won't see
   it again.
3. Make sure the workspace has some credit (**Billing**).

## 2. Install + link the Supabase CLI (once)

```bash
npm i -g supabase          # or: brew install supabase/tap/supabase
supabase login             # opens the browser
supabase link --project-ref <your-project-ref>   # the ref from your Supabase URL
```

## 3. Deploy the proxy + store the key as a secret

```bash
# from the repo root
supabase functions deploy claude

supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
# optional — pin a model (default is claude-sonnet-4-5):
supabase secrets set CLAUDE_MODEL=claude-sonnet-4-5
```

The function URL is:

```
https://<your-project-ref>.functions.supabase.co/claude
```

Quick check that it's live (should return JSON from Claude):

```bash
curl -s -X POST https://<ref>.functions.supabase.co/claude \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"say hi in 3 words"}]}'
```

## 4. Point the app at the proxy — in BOTH places

**Vercel** (live site) → Settings → Environment Variables:

| Name | Value |
| --- | --- |
| `VITE_CLAUDE_PROXY_URL` | `https://<ref>.functions.supabase.co/claude` |

Then **Redeploy**.

**Local `.env`:**

```bash
VITE_CLAUDE_PROXY_URL=https://<ref>.functions.supabase.co/claude
```

```bash
npm run dev
```

## 5. Verify inside the app

Go to **Daily Scrum**, paste a note, hit **Organise with AI**. If the pill reads
“AI organised” (not “Offline parse”), Claude is live. The Designer-LLD generator,
the Complete-Now verification questions, and the Work-update KPI score now all
use real Claude too.

---

## The key never touches the browser

`VITE_CLAUDE_PROXY_URL` is just a URL — safe to expose. The actual
`ANTHROPIC_API_KEY` lives only as a Supabase secret on the server side. That's
why the proxy is the recommended path.

### Local-only shortcut (not for production)

For a fast local test without deploying a function, you can skip steps 2–4 and
put the key straight in `.env`:

```bash
VITE_ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

This calls Anthropic directly from the browser and **exposes the key in the
bundle** — never ship it. Remove it and use the proxy for anything real.

### Troubleshooting

- **Still shows “Offline parse”:** `VITE_CLAUDE_PROXY_URL` isn't in the build —
  check it's set for the right Vercel environment and that you redeployed.
- **Function returns `ANTHROPIC_API_KEY not set`:** run the `supabase secrets
  set` step, then `supabase functions deploy claude` again.
- **401 / auth error from the function:** the CLI didn't pick up the secret, or
  the key is wrong/'`service`'-scoped — recreate the key in the console.
- **`credit balance is too low`:** add credit in the Anthropic console → Billing.
