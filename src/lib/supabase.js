import { createClient } from "@supabase/supabase-js";

/* ─── SUPABASE CLIENT ─────────────────────────────────────────────────────────
   Created only when both env vars are present. When absent, `supabase` is null
   and the app falls back to localStorage — so it still runs with zero config.
   Set these in `.env` (see .env.example) to turn on real cloud persistence.   */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(url && anonKey);

export const supabase = supabaseEnabled
  ? createClient(url, anonKey, { auth: { persistSession: false } })
  : null;

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
