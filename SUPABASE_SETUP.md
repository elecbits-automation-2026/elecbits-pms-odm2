# Attach Supabase — step by step

This connects the live app (`elecbits-pms-odm2.vercel.app`) to your own
Supabase project: **login**, **cloud database**, and the **pgvector** memory.
Takes ~10 minutes. Nothing here changes the code — it's all keys + one SQL run.

> Until you do this, the app runs in **demo mode** (no login, seed users,
> localStorage). The moment the two `VITE_SUPABASE_*` vars are present, it
> switches to real login + Postgres automatically.

---

## 1. Create the project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Name it (e.g. `elecbits-pms`), set a strong DB password, pick a region close
   to your team. Wait ~2 min for it to provision.

## 2. Create every table (one SQL run)

1. In the project: **SQL editor → New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy the
   **whole file**, paste it in, and click **Run**.
3. You should see “Success. No rows returned.” This creates all tables, enables
   **pgvector**, adds the semantic-memory function, sets up Row-Level Security,
   and installs the trigger that makes a profile for each new user.

## 3. Copy your keys

1. **Settings (gear) → API**.
2. Copy two values:
   - **Project URL** → `https://<project-ref>.supabase.co`
   - **Project API keys → `anon` `public`** (the long one)

## 4. Set the env vars — in BOTH places

The live site is on Vercel, so the vars must be set in Vercel. For local dev,
also put them in `.env`.

**Vercel (for the live site):** your Vercel project → **Settings → Environment
Variables** → add:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | your `anon public` key |

Then **Deployments → … → Redeploy** (env vars only apply to a fresh build).

**Local (`.env` in the repo root — git-ignored):**

```bash
cp .env.example .env
# then edit .env:
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```

```bash
npm run dev   # http://localhost:5173 — you'll now see the login screen
```

## 5. Make the first account (= admin)

1. Open the app → **Create one** → sign up with your work email + password.
2. The schema trigger makes the **first** registered user the **superadmin**;
   everyone who signs up after is an `engineer`.
3. Promote others later in Supabase: **Table editor → `profiles`** → set a row's
   `role` to `pm`, `dept_head`, or `superadmin`.

> **Can't log in right after sign-up?** Supabase turns on email confirmation by
> default. For a fast internal rollout, disable it:
> **Authentication → Providers → Email → turn off “Confirm email”**. Or just
> click the confirmation link in the email Supabase sends.

---

## Done ✓

Login now works, the roster comes from `profiles`, and data persists to
Postgres. Two optional add-ons (both already coded — see the main README):

- **Live Claude in all AI windows** — deploy the `claude` Edge Function and set
  `VITE_CLAUDE_PROXY_URL`.
- **Google Drive/Sheets sync** — deploy the `drive-sync` Edge Function and set
  `VITE_DRIVE_SYNC_URL`.

### Quick sanity checks

- **Login screen doesn't appear (still demo mode):** the two `VITE_SUPABASE_*`
  vars aren't reaching the build. On Vercel, confirm they're set for the right
  environment and that you redeployed after adding them.
- **“Invalid API key” on sign-in:** you used the `service_role` key or a stale
  key — use the `anon` `public` key.
- **Sign-up succeeds but you're stuck at login:** email confirmation is on
  (see the note above).
