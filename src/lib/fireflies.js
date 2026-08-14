/* ─── MEETINGS → THE SCRUM ────────────────────────────────────────────────────
   Fireflies records the Google Meet call; the `fireflies` Edge Function reads
   it and keeps the transcript. This is the browser's side of that: it asks for
   the day's meetings and pulls one in. The API key never comes near here —
   what crosses the wire is what the meeting said, not the credential that
   could read every meeting the company has recorded.                        */

import { supabase } from "./supabase.js";
import { tbl, withLayoutRetry } from "./tables.js";

const URL_ = (import.meta.env.VITE_FIREFLIES_URL || "").trim();
export const firefliesEnabled = Boolean(URL_);

async function userJwt() {
  if (!supabase) return "";
  try { return (await supabase.auth.getSession())?.data?.session?.access_token || ""; }
  catch { return ""; }
}

async function call(payload, ms = 45000) {
  if (!URL_) {
    return { error: "Fireflies isn't connected in this build — set VITE_FIREFLIES_URL." };
  }
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      signal: ctrl.signal,
      // text/plain on purpose: it avoids a CORS preflight, and the token in the
      // body is verified server-side exactly as an Authorization header is.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, userJwt: await userJwt() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { error: data.error || (res.status === 404
        ? "The fireflies function isn't deployed yet."
        : `Fireflies wouldn't answer (${res.status}).`) };
    }
    return data;
  } catch (e) {
    return { error: e?.name === "AbortError"
      ? "Fireflies took too long to answer — try again."
      : `Couldn't reach the meeting recorder: ${e?.message || e}` };
  } finally { clearTimeout(bail); }
}

/* Which meetings happened on this day. `date` is YYYY-MM-DD in local terms —
   the offset goes with it so "today" means the caller's today, not UTC's. */
export async function listMeetings(date) {
  const r = await call({ action: "list", date, tzOffsetMinutes: new Date().getTimezoneOffset() });
  return r.error ? { meetings: [], error: r.error } : { meetings: r.meetings || [], error: "" };
}

/* Pull one meeting in: the server stores the full transcript and hands back
   the readable part for the scrum box. */
export async function importMeeting(id, { projectId = "", noteId = "" } = {}) {
  const r = await call({ action: "import", id, projectId, noteId }, 90000);
  if (r.error) return { error: r.error };
  return {
    error: "",
    id: r.id,
    title: r.title || "",
    date: r.date || "",
    durationMin: r.durationMin ?? null,
    meetingLink: r.meetingLink || "",
    attendees: r.attendees || [],
    wordCount: r.wordCount || 0,
    text: r.text || "",
    // The meeting is still usable when the copy could not be kept — say so
    // rather than pretending it was filed.
    stored: !!r.stored,
    storeError: r.storeError || "",
  };
}

/* The transcripts already kept for a day, read straight from the table —
   they are far too big to live in the workspace blob. */
export async function transcriptsForDay(date) {
  if (!supabase) return { rows: [], error: "" };
  try {
    const { data, error } = await withLayoutRetry(supabase, () =>
      tbl(supabase, "transcripts")
        .select("id, external_id, title, meeting_date, duration_min, meeting_link, word_count, attendees, note_app_id")
        .eq("meeting_date", date)
        .order("started_at", { ascending: true }));
    if (error) throw error;
    return { rows: data || [], error: "" };
  } catch (e) {
    // A project that has not run the migration yet simply has no transcripts;
    // that is not an error worth putting in front of anyone.
    const msg = String(e?.message || e);
    if (/does not exist|schema cache|PGRST(106|205)/i.test(msg)) return { rows: [], error: "" };
    return { rows: [], error: msg };
  }
}

/* The whole transcript of one meeting, on demand. */
export async function transcriptText(externalId) {
  if (!supabase) return { text: "", error: "" };
  try {
    const { data, error } = await withLayoutRetry(supabase, () =>
      tbl(supabase, "transcripts").select("transcript, title").eq("external_id", externalId).maybeSingle());
    if (error) throw error;
    return { text: data?.transcript || "", title: data?.title || "", error: "" };
  } catch (e) { return { text: "", error: String(e?.message || e) }; }
}
