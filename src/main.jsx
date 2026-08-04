import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { supabase, supabaseEnabled, supabaseStorage } from "./lib/supabase.js";

/* ─── STORAGE SEAM ───────────────────────────────────────────────────────────
   App.jsx persists through `window.storage` (get/set/delete → { value }).

   • Supabase configured  → real cloud persistence via the `app_kv` table, so
     the same data follows the team across devices and sessions.
   • Otherwise            → localStorage, so the app still persists locally with
     zero setup.

   Either way the App code does not change. Supabase calls that fail fall back to
   localStorage for that operation, so a transient backend hiccup never loses the
   session — the App's own try/catch then keeps it running on seed data.        */
function localStorageBackend() {
  return {
    get: async (key) => {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    },
    set: async (key, value) => localStorage.setItem(key, value),
    delete: async (key) => localStorage.removeItem(key),
  };
}

if (typeof window !== "undefined" && !window.storage) {
  const local = localStorageBackend();
  if (supabaseEnabled) {
    const cloud = supabaseStorage(supabase);
    // Cloud-first with a localStorage safety net + mirror.
    window.storage = {
      get: async (key) => {
        try {
          return await cloud.get(key);
        } catch {
          return local.get(key);
        }
      },
      set: async (key, value) => {
        local.set(key, value); // keep an offline mirror
        try {
          await cloud.set(key, value);
        } catch {
          /* mirror already written */
        }
      },
      delete: async (key) => {
        local.delete(key);
        try {
          await cloud.delete(key);
        } catch {
          /* ignore */
        }
      },
    };
  } else {
    window.storage = local;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
