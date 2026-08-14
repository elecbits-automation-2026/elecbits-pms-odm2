// ═══════════════════════════════════════════════════════════════════════════
// Edge Function: meet
//
// Schedule a Google Meet from the dashboard. The event is created on the
// CALLER'S OWN calendar — not a shared robot account — so it appears in their
// diary, the invitees see who called the meeting, and the Meet belongs to a
// real person. Fireflies can be invited at the same time, which is what makes
// the loop close: schedule here, talk there, and the transcript comes back
// into the daily scrum on its own.
//
//   create   — a calendar event with a Meet link, invitees emailed
//   upcoming — the caller's next calls that have a Meet link
//   cancel   — call it off, and tell the invitees
//
// Google Calendar is the store. Nothing about the meeting is duplicated into
// our database: a second copy of a diary is a second copy to get out of date.
//
// Deploy: Edge Functions → Deploy a new function → name it `meet`, paste this,
// Verify JWT OFF (it verifies the caller itself).
// Secrets: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
//          GOOGLE_IMPERSONATE_USER, GOOGLE_WORKSPACE_DOMAIN — the same ones
//          the Drive reader already uses.
//
// ONE THING TO DO IN THE ADMIN CONSOLE: domain-wide delegation was granted for
// the Drive scope. Calendar is a separate scope and must be added to the SAME
// client ID, or every call here comes back "unauthorized_client":
//   Admin console → Security → API controls → Domain-wide delegation → edit
//   the service account's client ID → add
//   https://www.googleapis.com/auth/calendar.events
// ═══════════════════════════════════════════════════════════════════════════

const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const SA_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");
const IMPERSONATE = (Deno.env.get("GOOGLE_IMPERSONATE_USER") ?? "").trim().toLowerCase();
// `||` not `??`: an env var that is set-but-empty is unset in every way that
// matters, and `??` would keep the empty string.
const WORKSPACE_DOMAIN = ((Deno.env.get("GOOGLE_WORKSPACE_DOMAIN") || "").trim()
  || IMPERSONATE.split("@")[1] || "").toLowerCase();
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
/* Inviting this address is what puts the Fireflies notetaker in the call. It
   is configurable because Fireflies has changed it before and a hard-coded
   address would quietly stop recording anything. */
const NOTETAKER = (Deno.env.get("FIREFLIES_NOTETAKER_EMAIL") || "fred@fireflies.ai").trim().toLowerCase();

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CAL = "https://www.googleapis.com/calendar/v3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* Tolerant PEM → CryptoKey. The secret arrives from a dashboard paste, so it
   can carry JSON quotes, literal \n escapes, real newlines or stray spaces. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let s = String(pem).trim().replace(/^["']+|["']+$/g, "").replace(/\\n/g, "\n");
  if (!s) throw new Error("GOOGLE_PRIVATE_KEY is empty — add it under Edge Functions → Secrets.");
  const body = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
                .replace(/-----END [A-Z ]*PRIVATE KEY-----/, "")
                .replace(/[^A-Za-z0-9+/=]/g, "");
  if (body.length < 500) throw new Error("GOOGLE_PRIVATE_KEY looks truncated — paste the private_key value as one line with its \\n sequences.");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/* Who is calling? Their Supabase token answers, verified against Supabase.
   Never read from a field the browser filled in — otherwise anyone could put
   a meeting in anyone's diary. */
async function caller(req: Request, bodyJwt?: string): Promise<{ id: string; email: string } | null> {
  const hdr = req.headers.get("authorization") ?? "";
  const jwt = /^bearer /i.test(hdr) ? hdr.slice(7).trim() : String(bodyJwt ?? "").trim();
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return { id: String(u?.id ?? ""), email: String(u?.email ?? "").trim().toLowerCase() };
  } catch { return null; }
}

/* Only someone in the Workspace can have a meeting created as them; anyone
   else falls back to the shared account. */
const subjectFor = (email: string) =>
  (email && WORKSPACE_DOMAIN && email.endsWith("@" + WORKSPACE_DOMAIN)) ? email : IMPERSONATE;

const tokenCache = new Map<string, { token: string; exp: number }>();
const noDelegation = new Set<string>();

async function accessToken(subject: string): Promise<string> {
  const sub = noDelegation.has(subject) ? IMPERSONATE : subject;
  const hit = tokenCache.get(sub);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({
    iss: SA_EMAIL, ...(sub ? { sub } : {}), scope: CAL_SCOPE,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }))}`;
  const key = await importPrivateKey(SA_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Match the MACHINE-READABLE code, not the sentence beside it. Google's
    // code is `unauthorized_client` while its description reads "Client is
    // unauthorized to retrieve access tokens…" — testing only the description
    // silently skips the fallback and the useful error underneath.
    const code = String(data?.error ?? "");
    const why = String(data?.error_description || data?.error || res.status);
    // Delegation refused for THIS person — remember it and use the shared
    // account rather than failing outright. But if the scope itself was never
    // granted, no subject will work and saying so saves an hour of guessing.
    if (/unauthorized_client|access_denied|invalid_grant/i.test(code)
        || /unauthorized|not authorized|access denied|delegation/i.test(why)) {
      if (sub && sub !== IMPERSONATE) {
        noDelegation.add(sub);
        return accessToken(IMPERSONATE);
      }
      throw new Error(
        `Google refused the calendar scope (${why}). Add ${CAL_SCOPE} to this service account's ` +
        `client ID under Admin console → Security → API controls → Domain-wide delegation.`);
    }
    throw new Error(`Google refused the token: ${why}`);
  }
  tokenCache.set(sub, { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

/* A local wall-clock time in a named zone → the RFC3339 Calendar wants.
   Sending the date and the timeZone separately is the whole trick: Google
   applies the zone, so nobody has to compute an offset that daylight saving
   would invalidate twice a year anyway. */
const dateTime = (day: string, hhmm: string) => `${day}T${(hhmm || "09:00").padStart(5, "0")}:00`;

const meetLinkOf = (ev: any): string =>
  ev?.hangoutLink
  || (ev?.conferenceData?.entryPoints ?? []).find((e: any) => e?.entryPointType === "video")?.uri
  || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: any;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "invalid JSON body" }, 400); }

  const who = await caller(req, body.userJwt);
  if (!who) return json({ error: "Sign in first — a meeting has to belong to somebody." }, 401);
  const subject = subjectFor(who.email);
  if (!subject) {
    return json({ error: "No Google account to create the meeting as — set GOOGLE_IMPERSONATE_USER on this function." }, 500);
  }

  let token: string;
  try { token = await accessToken(subject); }
  catch (e) { return json({ error: String((e as Error).message || e) }, 502); }

  const tz = String(body.timeZone || "Asia/Kolkata");

  try {
    /* ── create ───────────────────────────────────────────────────────── */
    if (body.action === "create") {
      const day = String(body.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "Give me a date as YYYY-MM-DD." }, 400);
      const start = String(body.startTime || "09:00").slice(0, 5);
      const end = String(body.endTime || "").slice(0, 5)
        || `${String((Number(start.slice(0, 2)) + 1) % 24).padStart(2, "0")}:${start.slice(3, 5)}`;
      if (dateTime(day, end) <= dateTime(day, start)) {
        return json({ error: "The meeting has to end after it starts." }, 400);
      }

      const invitees = [...new Set(
        (body.attendees ?? []).map((a: string) => String(a || "").trim().toLowerCase()).filter((a: string) => a.includes("@")),
      )] as string[];
      // Inviting the notetaker is what gets the call recorded. Opt-in, because
      // not every meeting should be.
      if (body.recordWithFireflies && NOTETAKER) invitees.push(NOTETAKER);

      const event = {
        summary: String(body.title || "Elecbits meeting").slice(0, 250),
        description: [String(body.description || "").trim(), body.projectId ? `Project: ${body.projectId}` : ""]
          .filter(Boolean).join("\n\n") || undefined,
        start: { dateTime: dateTime(day, start), timeZone: tz },
        end: { dateTime: dateTime(day, end), timeZone: tz },
        attendees: invitees.map((email) => ({ email })),
        // requestId must be unique per request or Google reuses the previous
        // conference — which is how two different meetings end up on one link.
        conferenceData: {
          createRequest: {
            requestId: `eb-${day}-${start.replace(":", "")}-${crypto.randomUUID().slice(0, 8)}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
        // Elecbits project ids, kept on the event so a call can be traced back
        // to the work it was about.
        extendedProperties: body.projectId ? { private: { elecbitsProjectId: String(body.projectId) } } : undefined,
      };

      // conferenceDataVersion=1 is NOT optional: without it Google silently
      // ignores the createRequest and returns an event with no Meet link.
      const res = await fetch(
        `${CAL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
        { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event) },
      );
      const ev = await res.json();
      if (!res.ok) {
        return json({ error: `Google wouldn't create the meeting: ${ev?.error?.message || res.status}` }, 502);
      }
      const link = meetLinkOf(ev);
      return json({
        ok: true,
        eventId: ev.id,
        meetLink: link,
        // A calendar event with no Meet link is a trap — say so rather than
        // handing back a blank the caller will paste into a message.
        warning: link ? "" : "The event was created but Google returned no Meet link — check that Meet is enabled for this Workspace.",
        htmlLink: ev.htmlLink || "",
        title: ev.summary || "",
        start: ev.start?.dateTime || "",
        end: ev.end?.dateTime || "",
        organizer: subject,
        attendees: (ev.attendees ?? []).map((a: any) => a.email),
        // What we ASKED for versus what Google actually kept. A Workspace that
        // blocks external guests drops the notetaker silently, and the first
        // anyone would otherwise know is a call that produced no transcript.
        recording: !!body.recordWithFireflies,
        notetaker: NOTETAKER,
        notetakerInvited: (ev.attendees ?? []).some(
          (a: any) => String(a.email || "").toLowerCase() === NOTETAKER),
      });
    }

    /* ── upcoming ─────────────────────────────────────────────────────── */
    if (body.action === "upcoming") {
      const from = body.from ? new Date(String(body.from)) : new Date();
      const days = Math.min(30, Math.max(1, Number(body.days ?? 7)));
      const to = new Date(from.getTime() + days * 86400_000);
      const url = `${CAL}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50`
        + `&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) return json({ error: `Google wouldn't list the calendar: ${data?.error?.message || res.status}` }, 502);
      const meetings = (data.items ?? [])
        .map((ev: any) => ({
          eventId: ev.id,
          title: ev.summary || "(no title)",
          start: ev.start?.dateTime || ev.start?.date || "",
          end: ev.end?.dateTime || ev.end?.date || "",
          meetLink: meetLinkOf(ev),
          htmlLink: ev.htmlLink || "",
          projectId: ev.extendedProperties?.private?.elecbitsProjectId || "",
          attendees: (ev.attendees ?? []).map((a: any) => a.email),
          // Whether the notetaker is actually coming — the difference between
          // "we recorded it" and "we thought we did".
          recording: (ev.attendees ?? []).some((a: any) => String(a.email || "").toLowerCase() === NOTETAKER),
        }))
        .filter((m: any) => m.meetLink);
      return json({ ok: true, meetings, notetaker: NOTETAKER });
    }

    /* ── cancel ───────────────────────────────────────────────────────── */
    if (body.action === "cancel") {
      if (!body.eventId) return json({ error: "Tell me which meeting to cancel." }, 400);
      const res = await fetch(
        `${CAL}/calendars/primary/events/${encodeURIComponent(String(body.eventId))}?sendUpdates=all`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        const t = await res.text();
        return json({ error: `Google wouldn't cancel it: ${t.slice(0, 200)}` }, 502);
      }
      return json({ ok: true, cancelled: true });
    }

    return json({ error: `Unknown action "${body.action}".` }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
