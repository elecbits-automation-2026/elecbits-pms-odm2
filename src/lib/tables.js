/* ─── WHERE EVERY TABLE LIVES ─────────────────────────────────────────────────
   One map, one place. Table names used to be string literals scattered across
   three files; when the database was reorganised into schemas that meant
   hunting them down one by one. Now a move is an edit to this file.

   Two schemas matter to this app:

     core   what the whole company shares — people, orgs, projects,
            assignments. The ULM, HR, Finance, Box Build and Product tools
            read the same rows.
     pms    this tool's own working data — tasks, stages, meetings, the
            workspace blob.

   Both must be listed in Supabase → Settings → API → Exposed schemas, or
   PostgREST will answer 404 for everything here.                            */

/* logical name → [schema, table] */
const WHERE = {
  // ── core ──────────────────────────────────────────────────────────────
  people:      ["core", "people"],        // was public.profiles
  orgs:        ["core", "orgs"],          // was public.clients
  projects:    ["core", "projects"],
  assignments: ["core", "assignments"],   // was public.team_assignments
  trainings:   ["core", "trainings"],
  memory:      ["core", "memory"],
  sync_log:    ["core", "sync_log"],      // was public.drive_sync_log

  // ── pms ───────────────────────────────────────────────────────────────
  workspace:          ["pms", "workspace"],           // was public.app_kv
  tasks:              ["pms", "tasks"],
  stages:             ["pms", "stages"],              // was public.project_stages
  scrum_notes:        ["pms", "scrum_notes"],
  meetings:           ["pms", "meetings"],            // was public.moms
  meeting_ideas:      ["pms", "meeting_ideas"],
  meeting_decisions:  ["pms", "meeting_decisions"],
  meeting_challenges: ["pms", "meeting_challenges"],
  messages:           ["pms", "messages"],
  intel:              ["pms", "intel"],               // was public.project_intel
  work_updates:       ["pms", "work_updates"],
  kpi_log:            ["pms", "kpi_log"],
};

/* A query builder for a logical table. Everything that touches Postgres goes
   through here — `tbl(sb, "tasks")` rather than `sb.from("tasks")` — so the
   name and the schema are never written twice. */
export function tbl(sb, name) {
  const at = WHERE[name];
  if (!at) throw new Error(`Unknown table "${name}" — add it to src/lib/tables.js`);
  return sb.schema(at[0]).from(at[1]);
}

/* For error messages and logs: "core.people", not "people". */
export function tableName(name) {
  const at = WHERE[name];
  return at ? `${at[0]}.${at[1]}` : name;
}

export const TABLES = WHERE;
