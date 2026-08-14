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
// The notetaker's own address — the same one the `meet` function invites.
const NOTETAKER = (Deno.env.get("FIREFLIES_NOTETAKER_EMAIL") || "fred@fireflies.ai").trim().toLowerCase();
// Where a recording somebody uploaded is kept. Private — see
// supabase/add-recordings-bucket.sql.
const RECORDINGS_BUCKET = (Deno.env.get("RECORDINGS_BUCKET") || "recordings").trim();

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
/* Dropping an argument orphans its variable, and GraphQL rejects a declared
   variable nobody uses. Take the declaration out too. */
function dropUnusedVariables(q: string): string {
  const head = q.match(/^\s*(query|mutation)\s+\w*\s*\(([^)]*)\)/);
  if (!head) return q;
  const body = q.slice(head[0].length);
  const kept = head[2].split(",").map((s) => s.trim()).filter(Boolean)
    .filter((d) => {
      const name = d.match(/^\$([A-Za-z_]+)/)?.[1];
      return name ? new RegExp(`\\$${name}\\b`).test(body) : true;
    });
  const sig = kept.length ? `(${kept.join(", ")})` : "";
  return q.slice(0, head.index! + head[0].length).replace(/\([^)]*\)\s*$/, sig) + body;
}

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
    // "Unknown argument \"duration\" on field \"addToLiveMeeting\"." → same idea,
    // but an argument, and its variable declaration has to go with it. An
    // input-object field Fireflies has never heard of reads differently
    // ("Field X is not defined by type Y") and is dropped the same way.
    const badArgs = errs.flatMap((e) => {
      const m = String(e.message || "");
      return [
        m.match(/Unknown argument ["']([A-Za-z_]+)["']/)?.[1],
        m.match(/Field ["']([A-Za-z_]+)["'] is not defined by type/)?.[1],
      ].filter(Boolean) as string[];
    });
    // "Unknown type \"AudioUploadAttendeeInput\"." — a type name we guessed at.
    // Take out every variable declared with it, and everywhere it was used, so
    // the call goes through without that optional extra instead of failing.
    const badTypes = errs
      .map((e) => String(e.message || "").match(/Unknown type ["']([A-Za-z_]+)["']/)?.[1])
      .filter(Boolean) as string[];
    for (const t of badTypes) {
      for (const d of q.matchAll(new RegExp(`\\$([A-Za-z_]+)\\s*:\\s*\\[?${t}\\b`, "g"))) {
        badArgs.push(d[1]);
        q = q.replace(new RegExp(`\\$${d[1]}\\s*:\\s*\\[?${t}\\b\\]?!?`, "g"), "");
      }
    }
    if (!unknown.length && !badArgs.length && !badTypes.length) {
      return { error: errs[0]?.message || "Fireflies rejected the query." };
    }
    const before = q;
    for (const f of unknown) {
      // Remove the field wherever it appears as its own token, including a
      // block field with a brace body (`summary { ... }`).
      q = q.replace(new RegExp(`\\b${f}\\s*\\{[^{}]*\\}`, "g"), "")
           .replace(new RegExp(`(^|\\s)${f}(?=\\s|$)`, "g"), "$1");
    }
    for (const a of badArgs) q = q.replace(new RegExp(`,?\\s*\\b${a}:\\s*\\$[A-Za-z_]+`, "g"), "");
    q = dropUnusedVariables(q);
    if (q === before) return { error: errs[0]?.message || "Fireflies rejected the query." };
  }
  return { error: "Fireflies kept rejecting the query." };
}

/* "Fred, join this call." The optional arguments are dropped automatically if
   Fireflies does not know them, so a schema change costs a retry, not the
   feature. */
const JOIN_MUTATION = `
mutation SendFred($link: String!, $title: String, $duration: Int) {
  addToLiveMeeting(meeting_link: $link, title: $title, duration: $duration) {
    success
  }
}`;

/* Hand Fireflies a recording to transcribe. It fetches the audio itself, so
   what it gets is a URL — hence the signed link rather than the bytes. */
const UPLOAD_MUTATION = `
mutation UploadRecording($url: String!, $title: String, $attendees: [AudioUploadAttendeeInput]) {
  uploadAudio(input: { url: $url, title: $title, attendees: $attendees }) {
    success
    title
    message
  }
}`;

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

  /* ── send the notetaker into a call that is happening now ─────────────────
     Inviting fred@fireflies.ai to the calendar event is a hint, not a command:
     Fireflies only acts on it if the organiser's address is one of its own
     users and its calendar integration is live. When that chain is broken the
     guest sits on the invitation and never dials in. This asks Fireflies
     directly, which needs none of that — a link and a person who is in the
     call is enough. */
  if (body.action === "join") {
    const link = String(body.meetLink || "").trim();
    if (!/^https?:\/\//.test(link)) return json({ error: "Give me the Meet link to send Fred to." }, 400);
    const { data, error } = await fireflies(JOIN_MUTATION, {
      link,
      title: String(body.title || "Elecbits meeting"),
      duration: Number(body.durationMin) > 0 ? Math.min(Number(body.durationMin), 240) : 60,
    });
    if (error) {
      // The notetaker API is a paid feature; say so instead of relaying
      // "Forbidden" and leaving someone to guess.
      const plan = /not authorized|permission|plan|upgrade|subscription/i.test(error)
        ? " Sending the notetaker on demand needs a Fireflies Business plan or above."
        : "";
      return json({ error: error + plan }, 502);
    }
    const ok = data?.addToLiveMeeting?.success;
    return ok === false
      ? json({ error: "Fireflies took the request but would not join. Check that the call has started." }, 502)
      : json({ ok: true, joined: true, notetaker: NOTETAKER });
  }

  /* ── a recording somebody made themselves ─────────────────────────────────
     Not every call can have the notetaker in it: a client rings a phone, a
     site visit is caught on a handset, a meeting was recorded before anyone
     thought about transcripts. The audio is uploaded to the private
     `recordings` bucket; this hands Fireflies a signed link to fetch it with,
     which expires. Transcription is not instant — Fireflies calls the webhook
     above when it is done, and the transcript lands like any other. */
  if (body.action === "upload") {
    const path = String(body.path || "").replace(/^\/+/, "");
    if (!path) return json({ error: "Tell me which uploaded file to transcribe." }, 400);
    if (!SERVICE_KEY) return json({ error: "This function has no service key, so it cannot read the upload." }, 500);

    // Six hours is far longer than a fetch needs and far shorter than forever.
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${RECORDINGS_BUCKET}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      body: JSON.stringify({ expiresIn: 6 * 60 * 60 }),
    });
    const signed = await signRes.json().catch(() => ({} as any));
    if (!signRes.ok || !signed?.signedURL) {
      return json({ error: signRes.status === 404
        ? `That recording is not in storage — has the ${RECORDINGS_BUCKET} bucket been created? Run supabase/add-recordings-bucket.sql.`
        : `Couldn't get a link to the recording (${signRes.status}). ${signed?.message || ""}`.trim() }, 502);
    }
    const url = `${SUPABASE_URL}/storage/v1${signed.signedURL}`;

    const attendees = (Array.isArray(body.attendees) ? body.attendees : [])
      .map((a: any) => (typeof a === "string" ? { email: a } : a))
      .filter((a: any) => a?.email)
      .map((a: any) => ({ email: String(a.email), displayName: String(a.displayName || a.name || "") }));

    const { data, error } = await fireflies(UPLOAD_MUTATION, {
      url,
      title: String(body.title || "Recording").slice(0, 200),
      attendees,
    });
    if (error) {
      const plan = /not authorized|permission|plan|upgrade|subscription/i.test(error)
        ? " Uploading audio for transcription needs a Fireflies paid plan."
        : "";
      return json({ error: error + plan }, 502);
    }
    const r = data?.uploadAudio;
    if (r?.success === false) {
      return json({ error: r?.message || "Fireflies would not take that recording." }, 502);
    }
    // Deliberately not "done": Fireflies transcribes in the background and
    // calls the webhook when it has finished. Saying otherwise would send
    // someone looking for a transcript that is still minutes away.
    return json({ ok: true, queued: true, title: r?.title || body.title || "", message: r?.message || "" });
  }

  return json({ error: `Unknown action "${body.action}".` }, 400);
});
