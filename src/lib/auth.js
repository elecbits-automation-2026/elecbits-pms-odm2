import { supabase } from "./supabase.js";

/* ─── AUTH ─────────────────────────────────────────────────────────────────────
   Thin wrapper over Supabase Auth. Only meaningful when Supabase is configured;
   App.jsx guards every call behind `supabaseEnabled`, so the demo mode (no env)
   never touches these.                                                          */

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  if (!supabase) return { unsubscribe() {} };
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return data.subscription;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password, name) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export const ROLE_TITLES = {
  superadmin: "Super Admin",
  dept_head: "Dept Head — Project Management",
  pm: "Project Manager",
  engineer: "Engineer",
};
const RESOURCE_TITLES = {
  jr_pm: "Jr. Project Manager", sr_pm: "Sr. Project Manager",
  jr_fw: "Jr. Firmware Engineer", sr_fw: "Sr. Firmware Engineer",
  jr_hw: "Jr. Hardware Engineer", sr_hw: "Sr. Hardware Engineer",
  sc: "Supply Chain", ind_design: "Industrial Designer", sol_arch: "Solution Architect",
};
const PALETTE = ["#2563eb", "#7c3aed", "#ea580c", "#0891b2", "#16a34a", "#d97706", "#db2777", "#0d9488", "#9333ea", "#dc2626", "#4f46e5", "#0284c7"];

/* Roster. Prefers `profiles`; falls back to the existing `users` table (the
   org roster) when profiles is empty/absent, so the real team shows post-login. */
export async function fetchProfiles() {
  if (!supabase) return [];
  let rows = [];
  try {
    const { data, error } = await supabase.from("profiles").select("*").order("created_at");
    if (!error && data) rows = data;
  } catch { /* ignore */ }
  if (!rows.length) {
    try {
      const { data, error } = await supabase.from("users").select("*");
      if (!error && data) rows = data;
    } catch { /* ignore */ }
  }
  return rows.map((p, i) => {
    const role = p.role === "developer" ? "engineer" : (p.role || "engineer");
    return {
      id: p.id,
      // The login behind this person, once they have one. Null while a PM has
      // added them as a resource but they have not signed up yet.
      authId: p.auth_id || null,
      name: p.name || (p.email || "").split("@")[0] || "User",
      role,
      title: p.title || RESOURCE_TITLES[p.resource_role] || ROLE_TITLES[role] || "Team",
      color: p.color || PALETTE[i % PALETTE.length],
      email: p.email || "",
      // Full resource record, so Dept / capacity / skills survive a refresh.
      dept: p.dept || "",
      resourceRole: p.resource_role || "",
      skills: p.skills || [],
      maxProjects: p.max_projects || undefined,
      projectTags: p.project_tags || [],
    };
  });
}
