import { createClient } from "@supabase/supabase-js";

/* ─── SUPABASE CLIENT ─────────────────────────────────────────────────────────
   Created only when both env vars are present AND well-formed. A malformed URL
   makes createClient() throw; we catch it so a bad env var can never blank the
   whole app — it falls back to demo mode and logs a clear reason instead.       */
const url = (import.meta.env.VITE_SUPABASE_URL || "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

let client = null;
if (url && anonKey) {
  try {
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[Supabase] Could not initialise — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
        "(the URL must look like https://<ref>.supabase.co, no quotes or trailing slash). " +
        "Falling back to demo mode.",
      e
    );
    client = null;
  }
}

export const supabase = client;
export const supabaseEnabled = Boolean(client);

/* Key-value store backed by the `app_kv` Postgres table (see supabase/schema.sql).
   Matches the window.storage contract App.jsx uses: get → { value } | null. */
export function supabaseStorage(sb) {
  return {
    get: async (key) => {
      const { data, error } = await sb
        .from("app_kv")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (error) throw error;
      return data ? { value: data.value } : null;
    },
    set: async (key, value) => {
      const { error } = await sb
        .from("app_kv")
        .upsert({ key, value, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    delete: async (key) => {
      const { error } = await sb.from("app_kv").delete().eq("key", key);
      if (error) throw error;
    },
  };
}
