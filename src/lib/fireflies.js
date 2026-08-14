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

/* The `meet` function — scheduling the call, as opposed to reading it back. */
const MEET_URL = (import.meta.env.VITE_MEET_URL || "").trim();
export const meetEnabled = Boolean(MEET_URL);

/* The notetaker's own address. It is a guest on the call like anyone else —
   that invitation is the whole mechanism by which the recording happens, so
   it belongs in the guest list where people can see it, not hidden behind a
   checkbox. Must match FIREFLIES_NOTETAKER_EMAIL on the `meet` function. */
export const NOTETAKER =
  (import.meta.env.VITE_FIREFLIES_NOTETAKER || "fred@fireflies.ai").trim().toLowerCase();

async function userJwt() {
  if (!supabase) return "";
  try { return (await supabase.auth.getSession())?.data?.session?.access_token || ""; }
  catch { return ""; }
}

async function post(endpoint, payload, ms, missing) {
  if (!endpoint) return { error: missing };
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(endpoint, {
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
        ? "That function isn't deployed yet."
        : `Google/Fireflies wouldn't answer (${res.status}).`) };
    }
    return data;
  } catch (e) {
    return { error: e?.name === "AbortError"
      ? "It took too long to answer — try again."
      : `Couldn't reach the meeting service: ${e?.message || e}` };
  } finally { clearTimeout(bail); }
}

const call = (payload, ms = 45000) =>
  post(URL_, payload, ms, "Fireflies isn't connected in this build — set VITE_FIREFLIES_URL.");
const callMeet = (payload, ms = 45000) =>
  post(MEET_URL, payload, ms, "Google Meet isn't connected in this build — set VITE_MEET_URL.");

/* ── scheduling ──────────────────────────────────────────────────────────── */

/* Create the call. It lands on the caller's own calendar, invitees are
   emailed, and — when asked — the Fireflies notetaker is invited too, which
   is what makes the transcript come back on its own afterwards. */
export async function createMeeting({ title, date, startTime, endTime, attendees = [], projectId = "", description = "", record = true }) {
  const r = await callMeet({
    action: "create", title, date, startTime, endTime, attendees, projectId, description,
    recordWithFireflies: record,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
  }, 60000);
  return r.error ? { error: r.error } : { ...r, error: "" };
}

/* The caller's next calls that actually have a Meet link. Google Calendar is
   the store — we do not keep a second copy of anyone's diary. */
export async function upcomingMeetings(days = 7) {
  const r = await callMeet({ action: "upcoming", days });
  return r.error ? { meetings: [], error: r.error } : { meetings: r.meetings || [], notetaker: r.notetaker || "", error: "" };
}

/* Send the notetaker into a call that is running right now. The calendar
   invitation only works when Fireflies recognises the organiser and its
   calendar link is healthy; this asks Fireflies outright, so it works even
   when that chain is broken. The call has to have started — Fred cannot wait
   in an empty room. */
export async function sendNotetaker(meetLink, { title = "", durationMin = 60 } = {}) {
  const r = await call({ action: "join", meetLink, title, durationMin }, 60000);
  return r.error ? { error: r.error } : { joined: true, notetaker: r.notetaker || NOTETAKER, error: "" };
}

export async function cancelMeeting(eventId) {
  const r = await callMeet({ action: "cancel", eventId });
  return r.error ? { error: r.error } : { error: "" };
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

/* Every transcript kept between two days. The client-call log reads this —
   a conversation with the people paying for the work is worth finding weeks
   later, not just on the day it happened. */
export async function transcriptsBetween(from, to) {
  if (!supabase) return { rows: [], error: "" };
  try {
    const { data, error } = await withLayoutRetry(supabase, () =>
      tbl(supabase, "transcripts")
        .select("id, external_id, title, meeting_date, duration_min, meeting_link, word_count, attendees, project_id, note_app_id")
        .gte("meeting_date", from)
        .lte("meeting_date", to)
        .order("meeting_date", { ascending: false }));
    if (error) throw error;
    return { rows: data || [], error: "" };
  } catch (e) {
    const msg = String(e?.message || e);
    // No migration yet simply means no transcripts — not a failure to report.
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
