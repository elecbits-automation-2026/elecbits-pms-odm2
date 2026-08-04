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

/* Roster — every profile, shaped like the app's user objects. */
export async function fetchProfiles() {
  if (!supabase) return [];
  const { data, error } = await supabase.from("profiles").select("*").order("created_at");
  if (error) throw error;
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name || (p.email || "").split("@")[0] || "User",
    role: p.role || "engineer",
    title: p.title || ROLE_TITLES[p.role] || "Team",
    color: p.color || "#2563eb",
    email: p.email || "",
  }));
}

export const ROLE_TITLES = {
  superadmin: "Super Admin",
  dept_head: "Dept Head — Project Management",
  pm: "Project Manager",
  engineer: "Engineer",
};
