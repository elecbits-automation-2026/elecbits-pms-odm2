import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

/* ─── STORAGE SEAM ───────────────────────────────────────────────────────────
   App.jsx persists through `window.storage` (get/set/delete → { value }).
   Inside the artifact host that object is provided. In a normal browser it is
   not, so we shim it over localStorage — the app then persists across sessions
   anywhere. Swap this for your real backend (Supabase/edge functions) when the
   system moves into production; the App code does not change.                 */
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    get: async (key) => {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    },
    set: async (key, value) => {
      localStorage.setItem(key, value);
    },
    delete: async (key) => {
      localStorage.removeItem(key);
    },
  };
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
