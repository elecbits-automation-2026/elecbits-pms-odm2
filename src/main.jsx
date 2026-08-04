import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { supabase, supabaseEnabled, supabaseStorage } from "./lib/supabase.js";

/* ─── ERROR BOUNDARY ─────────────────────────────────────────────────────────
   Any render-time crash shows a readable message instead of a blank page, so a
   bad config surfaces its cause rather than a white/black void.                */
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error("App crashed:", err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#f8fafc", color: "#1e293b", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
        <div style={{ maxWidth: 540 }}>
          <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>Something went wrong loading the app</div>
          <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 14, lineHeight: 1.6 }}>
            This is almost always a bad environment variable — most often <code>VITE_SUPABASE_URL</code> (it must be exactly
            <code> https://&lt;ref&gt;.supabase.co</code>, with no quotes, spaces, or trailing slash). Fix it in Vercel and redeploy.
          </div>
          <pre style={{ fontSize: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap", color: "#dc2626", margin: 0 }}>{String(this.state.err?.message || this.state.err)}</pre>
        </div>
      </div>
    );
  }
}

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
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
