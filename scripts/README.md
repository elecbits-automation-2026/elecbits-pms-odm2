# Meetings health check

Signs in to the deployed app in a real browser and walks the Meet and Fireflies
features the way a person would, watching every call to the Edge Functions.

Everything that has actually broken with these two features was a deployment
problem, not a code problem — an env var set on the wrong Vercel project, a
function deployed under a slug nothing calls, the Calendar API switched off, a
table nobody created. All of those look identical from the outside: a button
that does nothing. This turns them into a named cause.

## Once

```bash
npm install
npx playwright install chromium
```

## Every time

```bash
export EB_PASSWORD='your password'

npm run check:meetings -- \
  --url https://elecbits-pms-odm2.vercel.app \
  --email you@elecbits.in
```

Exits `0` when everything passes, `1` when something is broken — so it can go
in CI or a cron job. Screenshots of each failure and a machine-readable
`report.json` land in `check-artifacts/`.

The password is read from `EB_PASSWORD` rather than a flag so it stays out of
your shell history.

## Flags

| Flag | What it does |
|---|---|
| `--live` | also creates a real Google Meet, checks the link and the notetaker came back, then cancels it |
| `--headed` | shows the browser so you can watch |
| `--out DIR` | where to put screenshots (default `check-artifacts`) |

**`--live` emails real people.** It creates an event called
`Elecbits health check HHMM — ignore` on the signed-in user's calendar and
cancels it a few seconds later, which sends an invitation and then a
cancellation to whoever was on the guest list. Without the flag the run never
writes anything: no event, no notetaker sent into a call, no upload.

## What it checks

**Reaching it** — the site answers, the app finishes loading rather than
hanging on "Loading the ODM system…", and the sign-in works.

**Daily Scrum** — the meetings panel is present at all (if it is missing, the
`VITE_*` variables are not in this build: they are read at BUILD time, so
adding them in Vercel does nothing until you redeploy), it opens, Fireflies
answers a request for today's meetings, the calendar is read, the scheduler
opens, and the notetaker is a visible ticked guest. It also guards two things
that moved: the client-call recorder must NOT be here, and the upload control
must be.

**Client Communication** — the section exists, calls can be set up and their
links handed over, projects are grouped under their clients with the
add-a-whole-client option, and the call log actually reads the transcripts
table.

**With `--live`** — a real meeting is created, a Meet link comes back (a
missing one usually means `conferenceDataVersion`), the notetaker survived onto
the guest list, and the event is cancelled again.

## What it cannot check

Whether the notetaker actually *joins* a call. That needs a call that is
running, with a person in it, and about a minute of waiting — so it is reported
as skipped rather than guessed at.

## Reading a failure

Failures print the function's own error, then a `WHAT TO DO` section naming the
cause. It knows about: the Calendar API being disabled, missing domain-wide
delegation, a function not deployed at the URL being called, Fireflies plan
limits, a missing or rejected `FIREFLIES_API_KEY`, the recordings bucket not
existing, and a function refusing the session.

Anything it does not recognise still shows the raw error and the full list of
Edge Function calls with their status codes, which is normally enough.
