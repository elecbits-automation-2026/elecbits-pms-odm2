/* ─── ADMIN-USERS — create or reset a person's login, from inside the app ────
   The Add Resource form lets an admin set an email AND a password, so the
   person can sign in immediately instead of self-registering. Creating a user
   with a chosen password needs the service-role key, which must never reach a
   browser — hence this function.

   Deploy it as `admin-users`. No secrets to add: Supabase injects
   SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY into every
   Edge Function automatically. If you deploy it under a different name, set
   VITE_ADMIN_USERS_URL in Vercel to its URL.

   POST { email, password, name }
     → { ok, created }        created=true  → fresh login, ready to use
                              created=false → the login existed; its password
                                              was RESET to the one given
   The caller must be signed in AND hold role superadmin or dept_head on the
   roster — checked server-side, never trusted from the browser.

   Accounts made here are marked email-confirmed, so they work even with
   "Confirm email" switched on, and regardless of any invite-only signup
   restriction — this path IS the invitation.                                 */

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const svc = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` };

/* Who is calling? Their own JWT answers; the anon key merely opens the door. */
async function caller(req: Request): Promise<{ id: string; email: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? { id: u.id, email: u.email ?? "" } : null;
}

/* Is that person an admin on the roster? Match by auth_id (post-migration),
   by id (pre-migration workspaces), or by email as the last resort. */
async function isAdmin(id: string, email: string): Promise<boolean> {
  const enc = encodeURIComponent;
  const ors = [`auth_id.eq.${id}`, `id.eq.${id}`];
  if (email) ors.push(`email.ilike.${email.replace(/[%,()]/g, "")}`);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=role&or=(${enc(ors.join(","))})`,
    { headers: svc },
  );
  if (!r.ok) return false;
  const rows: Array<{ role?: string }> = await r.json();
  return rows.some((p) => p.role === "superadmin" || p.role === "dept_head");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Function is missing its Supabase environment — redeploy it from the dashboard." }, 500);

  const who = await caller(req);
  if (!who) return json({ error: "You need to be signed in to manage logins." }, 401);
  if (!(await isAdmin(who.id, who.email))) return json({ error: "Only an admin can create or reset logins." }, 403);

  let body: { email?: string; password?: string; name?: string } = {};
  try { body = await req.json(); } catch { /* falls through to validation */ }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That doesn't look like an email address." }, 400);
  if (password.length < 8) return json({ error: "The password needs at least 8 characters." }, 400);

  // Create — or, if the login already exists, reset its password instead.
  let userId = "", created = true;
  const mk = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...svc, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name || email } }),
  });
  const mkBody = await mk.json().catch(() => ({}));
  if (mk.ok && mkBody?.id) {
    userId = mkBody.id;
  } else if (/already/i.test(String(mkBody?.msg ?? mkBody?.message ?? mkBody?.error_description ?? ""))) {
    created = false;
    const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: svc });
    const data = await list.json().catch(() => ({}));
    const found = (data?.users ?? []).find((u: { id: string; email?: string }) => (u.email ?? "").toLowerCase() === email);
    if (!found) return json({ error: "That email already has a login, but it couldn't be found to reset — reset it from the Supabase dashboard." }, 500);
    userId = found.id;
    const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: { ...svc, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!upd.ok) {
      const e = await upd.json().catch(() => ({}));
      return json({ error: `Couldn't reset the password — ${e?.msg ?? e?.message ?? upd.status}.` }, 500);
    }
  } else {
    return json({ error: `Couldn't create the login — ${mkBody?.msg ?? mkBody?.message ?? mk.status}.` }, 500);
  }

  // Attach the login to the roster entry with the same email, so the app
  // knows this row is them. Best-effort: the signup trigger also does this.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=ilike.${encodeURIComponent(email.replace(/[%,()]/g, ""))}`, {
      method: "PATCH",
      headers: { ...svc, "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({ auth_id: userId }),
    });
  } catch { /* not fatal — attachment also happens at first sign-in */ }

  return json({ ok: true, created });
});
