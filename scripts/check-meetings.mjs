#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   MEETINGS HEALTH CHECK — drives a real browser against the deployed app
   ───────────────────────────────────────────────────────────────────────────
   Everything that has actually gone wrong with Meet and Fireflies has been a
   DEPLOYMENT problem, not a code problem: an env var set on the wrong Vercel
   project, a function deployed under a slug nothing calls, the Calendar API
   switched off, a table nobody created. None of that shows up in a unit test
   and all of it looks identical from the outside — a button that does nothing.

   So this signs in like a person, walks both features, watches every call to
   the Edge Functions, and turns what it sees into a cause rather than a
   symptom.

     npm run check:meetings -- --url https://elecbits-pms-odm2.vercel.app \
                               --email you@elecbits.in

   The password comes from EB_PASSWORD, so it stays out of your shell history.

   READ-ONLY BY DEFAULT. It never creates a calendar event, never sends the
   notetaker into a call, never uploads a file — all of those touch real
   people's diaries and inboxes. Pass --live to include a create-then-cancel
   round trip, which does briefly email the invitees.
   ═══════════════════════════════════════════════════════════════════════════ */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* ── what we were asked to do ─────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  return argv[argv.indexOf(hit) + 1] ?? "";
};
const flag = (name) => argv.includes(`--${name}`);

const URL_ = (arg("url") || process.env.EB_URL || "").replace(/\/+$/, "");
const EMAIL = arg("email") || process.env.EB_EMAIL || "";
const PASSWORD = process.env.EB_PASSWORD || arg("password");
const LIVE = flag("live");
const HEADED = flag("headed");
const OUT_DIR = arg("out") || "check-artifacts";

if (!URL_ || !EMAIL || !PASSWORD) {
  console.error(`
Usage:  node scripts/check-meetings.mjs --url <deployed url> --email <you@elecbits.in>
        EB_PASSWORD must be set in the environment.

  --live     also create a real Google Meet and then cancel it (emails invitees)
  --headed   watch it happen in a visible browser
  --out DIR  where to put screenshots (default: check-artifacts)
`);
  process.exit(2);
}

/* ── the report ───────────────────────────────────────────────────────────── */
const results = [];
const check = (area, name, ok, detail = "") => {
  results.push({ area, name, ok: ok === true, skipped: ok === null, detail });
  const mark = ok === null ? "  ·  " : ok ? " PASS" : " FAIL";
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok === true;
};

/* Every call the page made to an Edge Function, with its status and whatever
   the function said. This is where a cause comes from: the UI only ever shows
   "nothing happened". */
const fnCalls = [];
const errorsSeen = () => fnCalls.filter((c) => c.status >= 400 || c.error).map((c) => `${c.fn}:${c.action} → ${c.status} ${c.error || ""}`.trim());

/* Turn what we saw into what to do about it. Ordered: the first rule that
   matches is the one printed, so put the specific causes above the vague ones. */
const CAUSES = [
  [/has not been used in project|accessNotConfigured|Calendar API/i,
   "The Google Calendar API is switched off for the service account's project. Enable it: APIs & Services → Library → Google Calendar API → Enable, then wait a minute."],
  [/unauthorized_client|Domain-wide delegation|delegation/i,
   "Domain-wide delegation is missing the calendar scope. Admin console → Security → API controls → Domain-wide delegation → add https://www.googleapis.com/auth/calendar.events to the service account's client ID."],
  [/isn't deployed yet|404/i,
   "The Edge Function is not deployed at the URL the app is calling. Check the function's SLUG in Supabase — a slug is fixed at creation, so a renamed function keeps its old URL (drive-read is deployed as `rapid-service`)."],
  [/Business plan|paid plan|not authorized|permission/i,
   "Fireflies refused on plan grounds. Sending the notetaker on demand and uploading audio both need a paid Fireflies tier."],
  [/FIREFLIES_API_KEY/i,
   "FIREFLIES_API_KEY is not set on the fireflies function. Supabase → Edge Functions → fireflies → Secrets."],
  [/refused the API key/i,
   "FIREFLIES_API_KEY is set but Fireflies rejected it — regenerate the key in Fireflies and update the secret."],
  [/nowhere to put recordings|recordings bucket|add-recordings-bucket/i,
   "The recordings bucket does not exist. Run supabase/add-recordings-bucket.sql."],
  [/401|Sign in first/i,
   "The function refused the session. Check that 'Verify JWT' is OFF for it, and that SUPABASE_URL / SUPABASE_ANON_KEY are set in its secrets."],
];
const causeFor = (text) => CAUSES.find(([re]) => re.test(text))?.[1] || "";

/* ── drive it ─────────────────────────────────────────────────────────────── */
await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: !HEADED, executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
});

/* Watch the two functions. The request body says which action was asked for;
   the response says what came back. */
page.on("response", async (res) => {
  const u = res.url();
  if (!/\/functions\/v1\/|\/fireflies|\/meet\b/.test(u)) return;
  const fn = /fireflies/.test(u) ? "fireflies" : /meet/.test(u) ? "meet" : u.split("/").pop();
  let action = "";
  try { action = JSON.parse(res.request().postData() || "{}").action || ""; } catch { /* not ours */ }
  let error = "";
  try {
    const body = await res.json();
    error = body?.error || "";
  } catch { /* not json */ }
  fnCalls.push({ fn, action, status: res.status(), error });
});

const shot = async (name) => {
  const f = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return f;
};

/* The app has no test ids, so find things the way a person reads them. */
const clickText = (label) => page.evaluate((l) => {
  const el = [...document.querySelectorAll("div,button,a")]
    .filter((e) => e.children.length <= 3 && (e.innerText || "").trim() === l).pop();
  if (el) { el.click(); return true; }
  return false;
}, label);
const clickMatching = (re) => page.evaluate((src) => {
  const rx = new RegExp(src);
  const el = [...document.querySelectorAll("button,div")].filter((e) => rx.test((e.innerText || "").trim())).pop();
  if (el) { el.click(); return true; }
  return false;
}, re.source);
const text = () => page.innerText("body");
const wait = (ms) => page.waitForTimeout(ms);

let failed = false;
const fail = () => { failed = true; };

try {
  /* ── 1. it is up, and we can get in ────────────────────────────────────── */
  console.log(`\n▸ ${URL_}\n`);
  console.log("REACHING IT");
  const res = await page.goto(URL_, { waitUntil: "networkidle", timeout: 60000 });
  check("app", "the site answers", res?.ok() === true, `HTTP ${res?.status()}`) || fail();
  await wait(1500);

  let body = await text();
  if (/Loading the ODM system/i.test(body)) {
    await wait(6000);
    body = await text();
  }
  if (/Loading the ODM system/i.test(body)) {
    check("app", "the app finishes loading", false, "still on the loading screen — the database layer is not answering") || fail();
    await shot("stuck-loading");
  } else {
    check("app", "the app finishes loading", true);
  }

  const emailBox = await page.$('input[type="email"]');
  if (emailBox) {
    await emailBox.fill(EMAIL);
    await (await page.$('input[type="password"]')).fill(PASSWORD);
    await clickMatching(/^(Continue|Sign in)$/);
    await wait(4000);
  }
  body = await text();
  const signedIn = !/input\[type="email"\]/.test(body) && !(await page.$('input[type="password"]'));
  check("app", "signed in", signedIn, signedIn ? EMAIL : "the login form is still on screen") || fail();
  if (!signedIn) { await shot("login-failed"); throw new Error("cannot continue without a session"); }

  /* ── 2. Daily Scrum: the meetings panel ────────────────────────────────── */
  console.log("\nDAILY SCRUM");
  await clickText("Daily Scrum");
  await wait(1500);
  body = await text();

  const panel = /Meeting transcripts/.test(body);
  check("scrum", "the meetings panel is on the page", panel,
    panel ? "" : "hidden — VITE_FIREFLIES_URL / VITE_MEET_URL are not baked into THIS deployment (they are read at BUILD time, so adding them in Vercel does nothing until you redeploy)") || fail();
  if (!panel) await shot("panel-missing");

  if (panel) {
    await clickText("Show");
    await wait(1200);
    body = await text();
    check("scrum", "the panel opens", /Find meetings/.test(body)) || fail();

    // Fireflies: today's meetings
    const before = fnCalls.length;
    await clickText("Find meetings");
    await wait(6000);
    body = await text();
    const listCall = fnCalls.slice(before).find((c) => c.fn === "fireflies" && c.action === "list");
    if (!listCall) {
      check("fireflies", "asking Fireflies for today's meetings", false, "the app never called the function") || fail();
    } else if (listCall.status >= 400 || listCall.error) {
      check("fireflies", "asking Fireflies for today's meetings", false, `${listCall.status} ${listCall.error}`) || fail();
      await shot("fireflies-list-failed");
    } else {
      const n = (body.match(/Pull into scrum/g) || []).length;
      check("fireflies", "asking Fireflies for today's meetings", true,
        n ? `${n} meeting(s) found` : "answered, nothing recorded today (not an error)");
    }

    // Meet: what is coming up
    const upcoming = fnCalls.find((c) => c.fn === "meet" && c.action === "upcoming");
    if (!upcoming) {
      check("meet", "reading your calendar", false, "the app never called the function") || fail();
    } else if (upcoming.status >= 400 || upcoming.error) {
      check("meet", "reading your calendar", false, `${upcoming.status} ${upcoming.error}`) || fail();
      await shot("meet-upcoming-failed");
    } else {
      check("meet", "reading your calendar", true,
        /Coming up/.test(body) ? "upcoming calls listed" : "answered, nothing scheduled (not an error)");
    }

    // The scheduler, and the notetaker's place in it
    await clickText("Schedule");
    await wait(1200);
    body = await text();
    const sched = /Who is coming/.test(body) && /Record it with Fireflies/.test(body);
    check("meet", "the scheduler opens", sched) || fail();
    if (sched) {
      const fred = await page.evaluate(() => {
        const el = [...document.querySelectorAll("div")]
          .filter((e) => (e.innerText || "").trim().startsWith("Fred (Fireflies)") && e.children.length <= 2).pop();
        return el ? el.innerText.trim() : "";
      });
      check("meet", "the notetaker is a visible, ticked guest", fred.includes("✓"),
        fred || "the Fred chip is not in the roster — this build predates it") || fail();
    }

    // Regression guards for things that moved
    check("scrum", "the client-call recorder is NOT here any more", !/Record a client's call/.test(body)) || fail();
    check("scrum", "a recording can be uploaded", /Upload a recording/.test(body)) || fail();
  }

  /* ── 3. Client Communication ───────────────────────────────────────────── */
  console.log("\nCLIENT COMMUNICATION");
  const navOk = await clickText("Client Communication");
  check("client", "the section is in the sidebar", navOk,
    navOk ? "" : "this build predates it — redeploy Vercel") || fail();

  if (navOk) {
    await wait(2500);
    body = await text();
    check("client", "the module loads", /Talk to the client/.test(body)) || fail();
    check("client", "a call can be set up", /Set up a call with the client/.test(body)) || fail();
    check("client", "their Teams link can be handed over", /Record a client's call/.test(body)) || fail();
    check("client", "a recording can be uploaded", /Upload a recording/.test(body)) || fail();

    // Projects grouped under their client — proves the multi-client picker
    await clickText("New client call");
    await wait(1000);
    const groups = await page.evaluate(() => {
      const sel = [...document.querySelectorAll("select")].find((s) => /which project/i.test(s.innerText || ""));
      if (!sel) return null;
      return {
        clients: [...sel.querySelectorAll("optgroup")].map((g) => g.label),
        bulk: [...sel.options].filter((o) => o.value.startsWith("client:")).length,
      };
    });
    if (!groups) {
      check("client", "projects are grouped by client", false, "the project picker was not found") || fail();
    } else {
      check("client", "projects are grouped by client", groups.clients.length > 0,
        groups.clients.slice(0, 4).join(", ") + (groups.clients.length > 4 ? ` +${groups.clients.length - 4}` : ""));
      check("client", "a whole client's projects can be added at once", groups.bulk > 0,
        `${groups.bulk} client(s) with more than one project`);
    }

    // The transcripts table — "no calls" and "no table" look the same on screen
    const listErr = fnCalls.find((c) => /transcripts/.test(c.error || ""));
    const callsShown = /Calls on record/.test(body);
    check("client", "the call log reads the transcripts table", callsShown && !listErr,
      listErr ? listErr.error
        : /No calls recorded yet/.test(body) ? "empty so far (run add-fireflies-transcripts.sql if you never have)"
        : "calls listed");
  }

  /* ── 4. optional: a real round trip ────────────────────────────────────── */
  if (LIVE) {
    console.log("\nLIVE ROUND TRIP  (creates a real event, then cancels it)");
    await clickText("Daily Scrum");
    await wait(1500);
    await clickText("Show");
    await wait(1000);
    await clickText("Schedule");
    await wait(1000);

    const stamp = new Date().toISOString().slice(11, 16).replace(":", "");
    const title = `Elecbits health check ${stamp} — ignore`;
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll("input")].find((i) => /What is the call about/.test(i.placeholder || ""));
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, t);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, title);
    await wait(400);

    const n = fnCalls.length;
    await clickMatching(/^Create the meeting$/);
    await wait(12000);
    body = await text();
    const created = fnCalls.slice(n).find((c) => c.fn === "meet" && c.action === "create");
    if (!created) {
      check("meet", "creating a real meeting", false, "the app never called the function") || fail();
    } else if (created.status >= 400 || created.error) {
      check("meet", "creating a real meeting", false, `${created.status} ${created.error}`) || fail();
      await shot("meet-create-failed");
    } else {
      const link = (body.match(/https:\/\/meet\.google\.com\/[a-z-]+/) || [])[0] || "";
      check("meet", "creating a real meeting", !!link, link || "no Meet link came back — conferenceDataVersion is the usual cause") || fail();
      check("meet", "the notetaker survived onto the guest list",
        !/was dropped from the guest list/.test(body),
        /was dropped from the guest list/.test(body) ? "Google removed the external guest — this call would NOT be recorded" : "");

      // Put it back the way we found it.
      await clickText("Close");
      await wait(800);
      await clickText("Show");
      await wait(2500);
      const cancelled = await page.evaluate((t) => {
        const rows = [...document.querySelectorAll("div")].filter((e) => (e.innerText || "").includes(t));
        const row = rows[rows.length - 1];
        const btn = [...(row?.querySelectorAll("button") || [])].find((b) => /Cancel/.test(b.innerText));
        if (btn) { btn.click(); return true; }
        return false;
      }, title);
      check("meet", "the test meeting was cancelled again", cancelled,
        cancelled ? "" : `could not find it to cancel — delete "${title}" from your calendar by hand`);
      await wait(4000);
    }
  } else {
    check("meet", "creating a real meeting", null, "skipped — pass --live to include it");
    check("fireflies", "sending the notetaker into a call", null, "skipped — needs a call that is actually running");
  }

  /* ── 5. anything the page itself threw ─────────────────────────────────── */
  console.log("\nBROWSER");
  check("app", "no JavaScript errors on the page", pageErrors.length === 0,
    pageErrors.slice(0, 2).join(" | ")) || fail();
} catch (e) {
  check("app", "the run completed", false, String(e?.message || e));
  fail();
  await shot("crashed");
} finally {
  await browser.close();
}

/* ── the verdict ──────────────────────────────────────────────────────────── */
const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
const broken = results.filter((r) => !r.ok && !r.skipped);

console.log("\n" + "─".repeat(66));
console.log(`${passed} passed · ${broken.length} failed · ${skipped} skipped`);

if (broken.length) {
  console.log("\nWHAT IS BROKEN");
  for (const b of broken) console.log(`  ✗ ${b.name}${b.detail ? ` — ${b.detail}` : ""}`);

  const causes = [...new Set(
    [...broken.map((b) => b.detail), ...errorsSeen()].map(causeFor).filter(Boolean),
  )];
  if (causes.length) {
    console.log("\nWHAT TO DO");
    for (const c of causes) console.log(`  → ${c}`);
  }
}

if (fnCalls.length) {
  console.log("\nEDGE FUNCTION CALLS");
  for (const c of fnCalls) {
    console.log(`  ${String(c.status).padEnd(4)} ${c.fn}:${c.action || "—"}${c.error ? `  ${c.error}` : ""}`);
  }
}

const report = { url: URL_, at: new Date().toISOString(), live: LIVE, results, fnCalls, pageErrors };
await writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nScreenshots and report.json in ${OUT_DIR}/`);

process.exit(failed ? 1 : 0);
