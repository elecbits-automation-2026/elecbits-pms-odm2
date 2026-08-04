/* ─────────────────────────────────────────────────────────────────────────────
   Bulk-create Supabase Auth accounts for the Elecbits team, and upsert a matching
   `profiles` row (with the correct role) for each. Run this LOCALLY with your
   SERVICE ROLE key — it must never be shipped to the browser.

   Every user is created with email confirmed and the same default password, so
   they can sign in immediately and change it later.

   Prereqs:
     1. Run supabase/schema.sql once (creates the profiles table + trigger).
     2. Get your service_role key: Supabase → Settings → API → "service_role" (secret).

   Usage (from the repo root):
     npm install                         # if you haven't
     export SUPABASE_URL="https://<your-ref>.supabase.co"
     export SUPABASE_SERVICE_ROLE_KEY="<service_role secret>"
     export DEFAULT_PASSWORD="Elecbits@2026"     # optional, this is the default
     node scripts/create-users.mjs

   Re-running is safe: existing users are detected and their profile is re-upserted.
   ───────────────────────────────────────────────────────────────────────────── */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.DEFAULT_PASSWORD || "Elecbits@2026";

if (!URL || !KEY) {
  console.error("✗ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables first.");
  process.exit(1);
}
const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const RESOURCE_TITLES = {
  jr_pm: "Jr. Project Manager", sr_pm: "Sr. Project Manager",
  jr_fw: "Jr. Firmware Engineer", sr_fw: "Sr. Firmware Engineer",
  jr_hw: "Jr. Hardware Engineer", sr_hw: "Sr. Hardware Engineer",
  sc: "Supply Chain", ind_design: "Industrial Designer", sol_arch: "Solution Architect",
};
const PALETTE = ["#2563eb", "#7c3aed", "#ea580c", "#0891b2", "#16a34a", "#d97706", "#db2777", "#0d9488", "#9333ea", "#dc2626", "#4f46e5", "#0284c7", "#059669", "#b45309", "#c026d3", "#e11d48", "#1e3a8a", "#65a30d", "#4338ca", "#be123c"];

// role: use CSV role but map "developer" → "engineer" (the app's role name).
// title override is used for the department heads.
const USERS = [
  { email: "shreya@elecbits.in", name: "Shreya", role: "superadmin", rr: "sr_pm", title: "Dept Head — Project Management" },
  { email: "saurav@elecbits.in", name: "Saurav", role: "superadmin", rr: "sr_pm", title: "Dept Head — Project Management" },
  { email: "nikhil@elecbits.in", name: "Nikhil", role: "superadmin", rr: "sol_arch", title: "Dept Head — Solution Architecture" },
  { email: "jerom.johnshibu@elecbits.in", name: "Jerom Johnshibu", role: "pm", rr: "jr_pm" },
  { email: "chhavi.bhatia@elecbits.in", name: "Chhavi Bhatia", role: "pm", rr: "jr_pm" },
  { email: "gargi.sharma@elecbits.in", name: "Gargi Sharma", role: "pm", rr: "jr_pm" },
  { email: "nived.p@elecbits.in", name: "Nived P", role: "pm", rr: "jr_pm" },
  { email: "anunay.dixit@elecbits.in", name: "Anunay Dixit", role: "pm", rr: "sr_pm" },
  { email: "axs@elecbits.in", name: "AXS", role: "pm", rr: "sr_hw" },
  { email: "rahul.singh@elecbits.in", name: "Rahul Singh", role: "developer", rr: "jr_hw" },
  { email: "yogesh@elecbits.in", name: "Yogesh", role: "developer", rr: "jr_hw" },
  { email: "ankit.ashokmishra@elecbits.in", name: "Ankit Ashok Mishra", role: "developer", rr: "jr_hw" },
  { email: "jeena.george@elecbits.in", name: "Jeena George", role: "developer", rr: "jr_hw" },
  { email: "arun.mohan@elecbits.in", name: "Arun Mohan", role: "developer", rr: "sr_hw" },
  { email: "amitabh.gogoi@elecbits.in", name: "Amitabh Gogoi", role: "developer", rr: "sr_fw" },
  { email: "aneesh.madhavan@elecbits.in", name: "Aneesh Madhavan", role: "developer", rr: "jr_fw" },
  { email: "vishnu.vardhan@elecbits.in", name: "Vishnu Vardhan", role: "developer", rr: "jr_fw" },
  { email: "swati.saxena@elecbits.in", name: "Swati Saxena", role: "developer", rr: "jr_fw" },
  { email: "sonu.kumar@elecbits.in", name: "Sonu Kumar", role: "developer", rr: "jr_fw" },
  { email: "sai.kiran@elecbits.in", name: "Sai Kiran", role: "developer", rr: "jr_fw" },
  { email: "israfil.khan@elecbits.in", name: "Israfil Khan", role: "developer", rr: "jr_fw" },
  { email: "sheik.ayesha@elecbits.in", name: "Ayesha Sheik", role: "developer", rr: "jr_fw" },
  { email: "nethravathi.gk@elecbits.in", name: "Nethravathi GK", role: "developer", rr: "jr_fw" },
  { email: "harshal.vaishampayan@elecbits.in", name: "Harshal Vaishampayan", role: "developer", rr: "sc" },
  { email: "anwer.suhail@elecbits.in", name: "Anwer Suhail", role: "developer", rr: "ind_design" },
];

async function findByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

let created = 0, existed = 0, failed = 0;
for (let i = 0; i < USERS.length; i++) {
  const u = USERS[i];
  const role = u.role === "developer" ? "engineer" : u.role;
  const title = u.title || RESOURCE_TITLES[u.rr] || "Team";
  const color = PALETTE[i % PALETTE.length];
  let id = null;
  try {
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { name: u.name },
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) {
        const ex = await findByEmail(u.email);
        if (!ex) { console.error(`✗ ${u.email} — exists but not found`); failed++; continue; }
        id = ex.id; existed++;
      } else { console.error(`✗ ${u.email} — ${error.message}`); failed++; continue; }
    } else { id = data.user.id; created++; }

    const { error: pe } = await sb.from("profiles").upsert({ id, email: u.email, name: u.name, role, title, color });
    if (pe) console.error(`  ! profile upsert failed for ${u.email}: ${pe.message}`);
    console.log(`✓ ${u.name.padEnd(22)} <${u.email}>  [${role}]`);
  } catch (e) {
    console.error(`✗ ${u.email} — ${e.message}`); failed++;
  }
}

console.log(`\nDone. created=${created}  existed=${existed}  failed=${failed}`);
console.log(`All accounts use the password: ${PASSWORD}`);
console.log(`Sign in at your app with any of the emails above + that password.`);
