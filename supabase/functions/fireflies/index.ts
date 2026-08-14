// ═══════════════════════════════════════════════════════════════════════════
// Edge Function: fireflies
//
// Fireflies sits in the Google Meet call and writes down what was said. This
// is the seam between that and the daily scrum:
//
//   list    — which meetings happened on a given day
//   import  — pull one meeting in: store the whole transcript, hand the
//             browser back the readable part to seed a scrum note
//   webhook — Fireflies calls this itself when a transcript is ready, so the
//             day's meetings are already waiting when someone opens Scrum
//
// The API key lives here and only here. It is never sent to the browser — the
// browser gets what the meeting SAID, not the key that could read every
// meeting the company has ever recorded.
//
// Deploy: Edge Functions → Deploy a new function → name it `fireflies`,
// paste this, turn Verify JWT OFF (it verifies the caller itself).
// Secrets: FIREFLIES_API_KEY, and the SUPABASE_* ones the platform injects.
// Then set VITE_FIREFLIES_URL in Vercel to this function's URL.
// ═══════════════════════════════════════════════════════════════════════════

const FIREFLIES_KEY = (Deno.env.get("FIREFLIES_API_KEY") ?? "").trim();
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// Fireflies signs its webhooks when you give it a secret; when it is set we
// refuse anything that does not carry the right signature.
const WEBHOOK_SECRET = (Deno.env.get("FIREFLIES_WEBHOOK_SECRET") ?? "").trim();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

/* ── who is calling ─────────────────────────────────────────────────────────
   Same rule as the Drive reader: the caller's Supabase token is verified
   against Supabase, never trusted from a field the browser filled in. */
async function callerId(req: Request, bodyJwt?: string): Promise<{ id: string; email: string } | null> {
  const hdr = req.headers.get("authorization") ?? "";
  const jwt = /^bearer /i.test(hdr) ? hdr.slice(7).trim() : String(bodyJwt ?? "").trim();
  if (!jwt || !SUPABASE_URL || !ANON_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return { id: String(u?.id ?? ""), email: String(u?.email ?? "").toLowerCase() };
  } catch { return null; }
}

/* ── talking to Fireflies ───────────────────────────────────────────────────
   Their GraphQL schema gains and loses fields over time, and GraphQL fails the
   WHOLE query for one unknown field. So: ask for everything useful, and if the
   server says a field does not exist, drop that field and ask again. A rename
   at their end costs a retry instead of an outage at ours. */
async function fireflies(query: string, variables: Record<string, unknown>): Promise<{ data?: any; error?: string }> {
  if (!FIREFLIES_KEY) return { error: "FIREFLIES_API_KEY is not set on this function." };
  let q = query;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.fireflies.ai/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${FIREFLIES_KEY}` },
        body: JSON.stringify({ query: q, variables }),
      });
    } catch (e) { return { error: `Couldn't reach Fireflies: ${e}` }; }

    if (res.status === 401 || res.status === 403) {
      return { error: "Fireflies refused the API key — check FIREFLIES_API_KEY in this function's secrets." };
    }
    if (res.status === 429) return { error: "Fireflies is rate-limiting us. Try again in a minute." };

    const body = await res.json().catch(() => ({} as any));
    const errs: Array<{ message?: string }> = body?.errors ?? [];
    if (!errs.length) {
      if (!res.ok) return { error: `Fireflies answered ${res.status}.` };
      return { data: body?.data };
    }

    // "Cannot query field \"meeting_link\" on type \"Transcript\"." → drop it.
    const unknown = errs
      .map((e) => String(e.message || "").match(/Cannot query field ["']([A-Za-z_]+)["']/)?.[1])
      .filter(Boolean) as string[];
    if (!unknown.length) return { error: errs[0]?.message || "Fireflies rejected the query." };
    const before = q;
    for (const f of unknown) {
      // Remove the field wherever it appears as its own token, including a
      // block field with a brace body (`summary { ... }`).
      q = q.replace(new RegExp(`\\b${f}\\s*\\{[^{}]*\\}`, "g"), "")
           .replace(new RegExp(`(^|\\s)${f}(?=\\s|$)`, "g"), "$1");
    }
    if (q === before) return { error: errs[0]?.message || "Fireflies rejected the query." };
  }
  return { error: "Fireflies kept rejecting the query." };
}

const LIST_QUERY = `
query Meetings($fromDate: DateTime, $toDate: DateTime, $limit: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit) {
    id title dateString duration organizer_email meeting_link
    meeting_attendees { displayName email }
  }
}`;

const ONE_QUERY = `
query Meeting($id: String!) {
  transcript(id: $id) {
    id title dateString duration organizer_email meeting_link participants
    meeting_attendees { displayName email }
    speakers { id name }
    summary { overview short_summary action_items keywords bullet_gist outline }
    sentences { index speaker_name raw_text start_time }
  }
}`;

/* ── shaping what came back ────────────────────────────────────────────── */
type Sentence = { index?: number; speaker_name?: string; raw_text?: string; start_time?: number };

const hhmm = (secs?: number) => {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/* The full record: every line, with who said it and when. This is what makes
   the transcript worth keeping — "we agreed X" is answerable from it. */
function fullText(sentences: Sentence[]): string {
  return (sentences || [])
    .map((s) => `[${hhmm(s.start_time)}] ${s.speaker_name || "Speaker"}: ${String(s.raw_text || "").trim()}`)
    .filter((l) => l.length > 12)
    .join("\n");
}

/* What goes into the scrum box: short enough for a person to read and correct,
   complete enough for the organiser to raise real tasks from. Action items
   first, because those ARE the tasks. */
function scrumText(t: any, sentences: Sentence[]): string {
  const sum = t?.summary ?? {};
  const bits: string[] = [];
  const when = t?.dateString ? new Date(t.dateString) : null;
  bits.push(`${t?.title || "Meeting"}${when ? ` — ${when.toISOString().slice(11, 16)}` : ""}${t?.duration ? `, ${Math.round(Number(t.duration))} min` : ""}`);
  const who = (t?.meeting_attendees ?? []).map((a: any) => a?.displayName || a?.email).filter(Boolean);
  if (who.length) bits.push(`Present: ${who.join(", ")}`);

  const actions = String(sum.action_items || "").trim();
  if (actions) bits.push(`\nAction items:\n${actions}`);

  const overview = String(sum.overview || sum.short_summary || "").trim();
  if (overview) bits.push(`\nWhat was discussed:\n${overview}`);

  const outline = String(sum.outline || sum.bullet_gist || "").trim();
  if (!overview && outline) bits.push(`\nWhat was discussed:\n${outline}`);

  // Nothing summarised — fall back to the opening of the transcript itself, so
  // the box is never empty when a real meeting happened.
  if (!actions && !overview && !outline) {
    const raw = fullText(sentences).slice(0, 2500);
    if (raw) bits.push(`\nTranscript (no summary was produced):\n${raw}`);
  }
  return bits.join("\n");
}

/* ── storing it ─────────────────────────────────────────────────────────────
   The tool's tables are in `pms` after the schema split and `public` before
   it. Try the one, fall back to the other — the same rule the app itself
   follows, so a half-migrated project still works. */
async function store(row: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, error: "Supabase env not present on this function." };
  for (const schema of ["pms", "public"]) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/transcripts?on_conflict=source,external_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        "content-type": "application/json",
        "content-profile": schema,
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([row]),
    });
    if (res.ok) return { ok: true };
    const text = await res.text();
    // Wrong schema for this project — try the other one before giving up.
    if (/PGRST106|PGRST205|does not exist|schema cache/i.test(text)) continue;
    return { ok: false, error: `Couldn't store the transcript: ${text.slice(0, 200)}` };
  }
  return { ok: false, error: "No `transcripts` table found in pms or public — run supabase/add-fireflies-transcripts.sql." };
}

async function importMeeting(id: string, opts: { projectId?: string; noteId?: string; by?: string }) {
  const { data, error } = await fireflies(ONE_QUERY, { id });
  if (error) return { error };
  const t = data?.transcript;
  if (!t) return { error: `Fireflies has no meeting with id ${id}.` };

  const sentences: Sentence[] = t.sentences ?? [];
  const transcript = fullText(sentences);
  const when = t.dateString ? new Date(t.dateString) : null;
  const sum = t.summary ?? {};
  const kw = Array.isArray(sum.keywords) ? sum.keywords
    : String(sum.keywords || "").split(",").map((s: string) => s.trim()).filter(Boolean);

  const row = {
    source: "fireflies",
    external_id: String(t.id),
    title: t.title ?? null,
    meeting_date: (when ?? new Date()).toISOString().slice(0, 10),
    started_at: when ? when.toISOString() : null,
    duration_min: t.duration != null ? Number(t.duration) : null,
    meeting_link: t.meeting_link ?? null,
    organizer_email: t.organizer_email ?? null,
    attendees: t.meeting_attendees ?? [],
    speakers: t.speakers ?? [],
    overview: sum.overview ?? sum.short_summary ?? null,
    action_items: sum.action_items ?? null,
    keywords: kw,
    transcript,
    sentences,
    word_count: transcript ? transcript.split(/\s+/).length : 0,
    project_id: opts.projectId || null,
    note_app_id: opts.noteId || null,
    imported_by: opts.by || null,
  };

  const saved = await store(row);
  // Storage failing must not cost the user the meeting — hand back the text
  // either way and say plainly that the copy was not kept.
  return {
    ok: true,
    stored: saved.ok,
    storeError: saved.error ?? "",
    id: String(t.id),
    title: t.title ?? "",
    date: row.meeting_date,
    durationMin: row.duration_min,
    meetingLink: row.meeting_link,
    attendees: (t.meeting_attendees ?? []).map((a: any) => a?.displayName || a?.email).filter(Boolean),
    wordCount: row.word_count,
    text: scrumText(t, sentences),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: any;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "invalid JSON body" }, 400); }

  /* ── Fireflies calling us when a transcript is ready ──────────────────── */
  // Its payload carries meetingId and no action of ours. There is no user
  // behind it, so it is authenticated by the shared secret instead.
  if (!body.action && body.meetingId) {
    if (WEBHOOK_SECRET) {
      const sig = req.headers.get("x-hub-signature") ?? "";
      if (!sig.includes(WEBHOOK_SECRET)) return json({ error: "bad signature" }, 401);
    }
    const out = await importMeeting(String(body.meetingId), {});
    return json(out, (out as any).error ? 502 : 200);
  }

  /* ── everything else is a signed-in person asking ─────────────────────── */
  const who = await callerId(req, body.userJwt);
  if (!who) return json({ error: "Sign in first — this needs your Supabase session." }, 401);

  if (body.action === "list") {
    // A day, in the caller's own timezone offset, so "today" means their today.
    const day = String(body.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const offsetMin = Number(body.tzOffsetMinutes ?? 0);
    const from = new Date(`${day}T00:00:00.000Z`); from.setMinutes(from.getMinutes() + offsetMin);
    const to = new Date(`${day}T23:59:59.999Z`); to.setMinutes(to.getMinutes() + offsetMin);

    const { data, error } = await fireflies(LIST_QUERY, {
      fromDate: from.toISOString(), toDate: to.toISOString(), limit: 50,
    });
    if (error) return json({ error }, 502);
    const meetings = (data?.transcripts ?? []).map((t: any) => ({
      id: String(t.id),
      title: t.title ?? "(untitled meeting)",
      at: t.dateString ?? null,
      durationMin: t.duration != null ? Math.round(Number(t.duration)) : null,
      meetingLink: t.meeting_link ?? null,
      organizer: t.organizer_email ?? null,
      attendees: (t.meeting_attendees ?? []).map((a: any) => a?.displayName || a?.email).filter(Boolean),
    }));
    return json({ ok: true, day, meetings });
  }

  if (body.action === "import") {
    if (!body.id) return json({ error: "Tell me which meeting to import." }, 400);
    const out = await importMeeting(String(body.id), {
      projectId: body.projectId ? String(body.projectId) : "",
      noteId: body.noteId ? String(body.noteId) : "",
      by: who.id,
    });
    return json(out, (out as any).error ? 502 : 200);
  }

  return json({ error: `Unknown action "${body.action}".` }, 400);
});
