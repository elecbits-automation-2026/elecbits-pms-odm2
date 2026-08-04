// ═══════════════════════════════════════════════════════════════════════════
// Edge Function: drive-sync
// The real Google Drive / Sheets integration seam. The frontend's sheetSync()
// posts { target, detail, at } here on every project create, scrum push and
// task closure. This function:
//   1) records the event in the drive_sync_log table (durable server-side log), and
//   2) appends a row to a Google Sheet using a Google service account.
// Both steps are best-effort and independent — the response reports each.
//
// Deploy:
//   supabase functions deploy drive-sync
//   supabase secrets set \
//     GOOGLE_SERVICE_ACCOUNT_EMAIL="svc@project.iam.gserviceaccount.com" \
//     GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" \
//     GOOGLE_SHEET_ID="<spreadsheet id>"  [GOOGLE_SHEET_TAB="SyncLog"]
//   (Share the target Sheet with the service-account email as an Editor.)
// Then set the frontend's VITE_DRIVE_SYNC_URL to this function's URL.
// ═══════════════════════════════════════════════════════════════════════════

const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const SA_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");
const SHEET_ID = Deno.env.get("GOOGLE_SHEET_ID") ?? "";
const SHEET_TAB = Deno.env.get("GOOGLE_SHEET_TAB") ?? "SyncLog";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// ── base64url helpers ──
const b64url = (data: ArrayBuffer | string) => {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// ── PEM (PKCS8) → CryptoKey for RS256 signing ──
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ── mint a Google OAuth access token from the service account ──
async function getAccessToken(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: SA_EMAIL,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importPrivateKey(SA_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

async function appendToSheet(row: string[]): Promise<void> {
  const token = await getAccessToken("https://www.googleapis.com/auth/spreadsheets");
  const range = encodeURIComponent(`${SHEET_TAB}!A:C`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`sheets append failed: ${await res.text()}`);
}

async function recordInSupabase(target: string, detail: string, at: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("supabase env not present");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/drive_sync_log`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ target, detail, at }),
  });
  if (!res.ok) throw new Error(`supabase insert failed: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let evt: { target?: string; detail?: string; at?: string };
  try {
    evt = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const target = evt.target ?? "";
  const detail = evt.detail ?? "";
  const at = evt.at ?? new Date().toISOString();

  const out: Record<string, string> = {};

  // 1) durable server-side record
  try {
    await recordInSupabase(target, detail, at);
    out.db = "logged";
  } catch (e) {
    out.db = `skipped: ${String(e)}`;
  }

  // 2) Google Sheet append
  if (SA_EMAIL && SA_KEY && SHEET_ID) {
    try {
      await appendToSheet([at, target, detail]);
      out.sheet = "appended";
    } catch (e) {
      out.sheet = `error: ${String(e)}`;
    }
  } else {
    out.sheet = "skipped: Google service-account env not set";
  }

  return json({ ok: true, ...out });
});
