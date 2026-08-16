// ═══════════════════════════════════════════════════════════════════════════
// Edge Function: drive-read
// The Google Drive READ seam. The frontend posts { projectId, linkedIds } and
// gets back a text digest of the project's real Drive contents: the matching
// PM / PCB folders, their file listings (name · type · modified), and text
// extracted from small Google Docs / text files. The digest is fed into the
// Drive-intelligence and Learn-from-Drive prompts.
//
// Deploy (dashboard: Edge Functions → New function → paste this, name it
// drive-read, turn OFF "Verify JWT" — or CLI: supabase functions deploy drive-read)
// Secrets (same service account as drive-sync):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// Share the ODM Drive folder (or the individual project folders) with the
// service-account email as a Viewer. Then set the frontend's
// VITE_DRIVE_READ_URL to this function's URL.
// ═══════════════════════════════════════════════════════════════════════════

const SA_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "";
const SA_KEY = (Deno.env.get("GOOGLE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/* The service-account address is an identifier, not a credential: it is what
   you add to a Drive folder's share list. Returning it on every response is
   what stops the assistant from having to invent it when someone asks "who do
   I share this with?" — and an invented one sends people down a dead end. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(typeof body === "object" && body ? { serviceAccount: SA_EMAIL, ...body } : body), { status, headers: { ...cors, "content-type": "application/json" } });

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* Tolerant PEM → CryptoKey.
   The secret arrives from a dashboard paste, so it can carry surrounding JSON
   quotes, literal \n escapes, real newlines, or stray whitespace. Anything
   left in the base64 body makes the DER invalid and crypto.subtle throws
   "incorrect length for PRIVATE" — so strip to base64 characters only. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let s = String(pem).trim();
  s = s.replace(/^["']+|["']+$/g, "");   // surrounding quotes from a JSON paste
  s = s.replace(/\\n/g, "\n");            // literal backslash-n escapes
  if (!s) throw new Error("GOOGLE_PRIVATE_KEY secret is empty — add it under Edge Functions → Secrets");
  if (/BEGIN RSA PRIVATE KEY/.test(s)) {
    throw new Error("GOOGLE_PRIVATE_KEY is PKCS#1 (BEGIN RSA PRIVATE KEY); Google's JSON key is PKCS#8 — re-copy the private_key field from the downloaded JSON");
  }
  // Accept a full PEM, or just the base64 body: some secret UIs cut everything
  // after the first newline, leaving the BEGIN/END lines behind.
  const body = s
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");     // drop newlines, spaces, quotes, anything else
  if (body.length < 500) {
    throw new Error(
      `GOOGLE_PRIVATE_KEY looks incomplete (only ${body.length} usable characters; a Google key has ~1600). ` +
      `The secret box likely cut it at the first line break — paste the private_key value as ONE line with literal \\n sequences, exactly as it appears inside the JSON file.`,
    );
  }
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("GOOGLE_PRIVATE_KEY is not valid base64 — re-paste it exactly as it appears in the JSON key file");
  }
  try {
    return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    throw new Error(`GOOGLE_PRIVATE_KEY could not be parsed (${e}). Copy the private_key value from the JSON key file verbatim — no surrounding quotes, keep the \\n sequences.`);
  }
}

// Full drive scope: the same service account both reads project folders and
// writes artefacts back (see the `write` action below). Share the ODM folder
// with the service-account email as an EDITOR for writes to succeed.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/* ── WHO THE WRITES BELONG TO ──────────────────────────────────────────────
   A service account owns no storage. Anything it creates in an ordinary My
   Drive folder has no owner with quota, and Google answers 403 "Service
   Accounts do not have storage quota" — reads are fine, writes are not.
   Two ways out, and this supports both:
     1. Put the ODM tree in a Shared Drive. The drive owns the files, so the
        service account can write with no further setup.
     2. Set GOOGLE_IMPERSONATE_USER to a real person in your Workspace (say
        odm@elecbits.in). The service account then acts as them and files are
        owned by them, on their quota. Needs domain-wide delegation switched
        on for this service account, with the drive scope.                   */
const IMPERSONATE = (Deno.env.get("GOOGLE_IMPERSONATE_USER") ?? "").trim().toLowerCase();

/* ── Who gets the credit for an upload ───────────────────────────────────────
   With domain-wide delegation the service account can act as ANY user in the
   Workspace, so a file can be created as the person who actually uploaded it:
   they own it, it counts against their quota, and Drive shows their name in
   "Owner" and "Last modified by" instead of one shared robot account.

   The identity is taken from the caller's SUPABASE ACCESS TOKEN, verified
   against Supabase on every request. It is never read from a field the browser
   supplies — otherwise anyone could impersonate anyone in the domain and write
   anywhere in Drive. A verified token is the only thing that grants it.

   Only addresses in the Workspace domain can be impersonated (Google would
   refuse anything else anyway). A contractor on a personal address, or a call
   with no token at all, falls back to GOOGLE_IMPERSONATE_USER.               */
// `||`, not `??`: an env var that is SET BUT EMPTY is unset in every way that
// matters here, and `??` would keep the empty string — silently disabling
// per-person attribution with no error to notice.
const WORKSPACE_DOMAIN = ((Deno.env.get("GOOGLE_WORKSPACE_DOMAIN") || "").trim()
  || IMPERSONATE.split("@")[1] || "").toLowerCase();
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

async function callerEmail(req: Request, bodyJwt?: string): Promise<string> {
  const hdr = req.headers.get("authorization") ?? "";
  // Header when the client can send one; body otherwise — the app posts
  // text/plain on purpose to avoid a CORS preflight, and both are equally safe
  // because the token is verified server-side either way.
  const jwt = /^bearer /i.test(hdr) ? hdr.slice(7).trim() : String(bodyJwt ?? "").trim();
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON) return "";
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return "";
    const u = await r.json();
    return String(u?.email ?? "").trim().toLowerCase();
  } catch { return ""; }
}

/* Which address this request should act as. */
function subjectFor(email: string): string {
  if (email && WORKSPACE_DOMAIN && email.endsWith("@" + WORKSPACE_DOMAIN)) return email;
  return IMPERSONATE;
}

/* One access token per impersonated subject, reused until it is nearly stale.
   Without this every request re-mints and re-exchanges a JWT. */
const tokenCache = new Map<string, { token: string; exp: number }>();
/* Subjects Google has refused to let us impersonate (delegation not granted,
   account suspended, not in the domain). Remembered so one bad address does
   not cost a failed round-trip on every single request. */
const noDelegation = new Set<string>();

async function getAccessToken(subject = IMPERSONATE): Promise<string> {
  const sub = noDelegation.has(subject) ? IMPERSONATE : subject;
  const nowMs = Date.now();
  const hit = tokenCache.get(sub);
  if (hit && hit.exp > nowMs + 60_000) return hit.token;

  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: SA_EMAIL,
    ...(sub ? { sub } : {}),
    scope: DRIVE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const input = `${header}.${claims}`;
  const key = await importPrivateKey(SA_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Delegation refused for THIS person: remember it and fall back to the
    // shared account rather than failing the upload outright.
    if (sub && sub !== IMPERSONATE) {
      noDelegation.add(sub);
      return getAccessToken(IMPERSONATE);
    }
    throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  }
  const token = data.access_token as string;
  tokenCache.set(sub, { token, exp: nowMs + (Number(data.expires_in ?? 3600) * 1000) });
  return token;
}

type GFile = { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; parents?: string[]; webViewLink?: string };

const FOLDER_MIME = "application/vnd.google-apps.folder";
const isFolder = (f: GFile) => f.mimeType === FOLDER_MIME;

async function drive(token: string, path: string): Promise<any> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`drive api ${res.status}: ${await res.text()}`);
  return res.json();
}

async function searchFolders(token: string, term: string): Promise<GFile[]> {
  const q = encodeURIComponent(`name contains '${term.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
  const data = await drive(token, `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,parents,webViewLink)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
  return data.files ?? [];
}

/* Forgiving lookup: people name folders inconsistently, so try progressively
   looser terms rather than reporting "not found". Drive's `contains` is
   case-insensitive, so variants here are about separators and length. */
async function findFolders(token: string, needle: string): Promise<GFile[]> {
  const raw = String(needle).trim();
  const tried = new Set<string>();
  const attempts: string[] = [];
  const push = (t?: string) => { const v = (t || "").trim(); if (v.length >= 3 && !tried.has(v.toLowerCase())) { tried.add(v.toLowerCase()); attempts.push(v); } };

  push(raw);                                   // exact-ish
  push(raw.replace(/[_\s]+/g, "-"));           // underscores/spaces → dashes
  push(raw.replace(/[-_\s]+/g, ""));           // no separators at all
  const parts = raw.split(/[-_\s]+/).filter(Boolean);
  if (parts.length > 2) {
    push(parts.slice(0, Math.max(2, parts.length - 1)).join("-")); // drop last chunk
    push(parts.slice(-2).join("-"));                                // last two chunks
  }
  push(parts.find((x) => /\d/.test(x) && x.length >= 3));           // the most number-like chunk

  for (const term of attempts) {
    const hits = await searchFolders(token, term);
    if (hits.length) return hits;
  }
  return [];
}

/* ── TIME BUDGET ───────────────────────────────────────────────────────────
   A project tree can be arbitrarily large and every listing is a network
   round trip, so the reader works to a wall clock and returns whatever it has
   when the time is up. A partial answer in twenty seconds beats a gateway
   timeout, which is what killed this before.                                */
const BUDGET_MS = 20000;
let deadline = Number.MAX_SAFE_INTEGER;
const outOfTime = () => Date.now() > deadline;

/* Round trips in batches instead of one at a time — the whole reason a big
   folder used to run past the gateway limit. */
async function inParallel<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    if (outOfTime()) break;
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/* One listing per folder per request — the search and the walk cover the same
   ground, and listing it twice was pure waste. Cleared on every request. */
let kidsCache = new Map<string, GFile[]>();
async function listChildren(token: string, folderId: string): Promise<GFile[]> {
  const hit = kidsCache.get(folderId);
  if (hit) return hit;
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const data = await drive(token, `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=200&orderBy=folder,modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const files: GFile[] = data.files ?? [];
  kidsCache.set(folderId, files);
  return files;
}
const listSafe = (token: string, id: string) => listChildren(token, id).catch(() => [] as GFile[]);

/* ── THE REAL ELECBITS TREE ────────────────────────────────────────────────
   Project folders are not scattered around Drive — they live at a fixed
   address, and searching the whole Drive by name lands on the wrong thing.
   Walk the chain instead:
     Eb-02-ODM / Eb-ODM Execution / Engineering Services / Project Management / <Project ID>
     Eb-02-ODM / Eb-ODM Execution / Engineering Services / PCB & Firmware    / <board folder>
   PMs work out of the first branch, engineers out of the second; both are
   reachable either way, only the order of looking changes.                  */
const ROOT_CHAIN = ["Eb-02-ODM", "Eb-ODM Execution", "Engineering Services"];
/* Preferred starting points, by who is asking. These are hints for the ORDER
   of looking, not the whole list — real work also sits in sibling folders like
   Eb-Hardware, so every child of Engineering Services is searched.

   These are deliberately STEMS, not the folders' full names. The real folders
   are "Project Management - Project Managers" and "PCB & Firmware - Engineers
   / Developers", and people extend those names from time to time. Matching on
   the stem means a rename that adds to the end costs nothing; putting the full
   name here would break the moment somebody appended another word. */
const BRANCH: Record<string, string> = { pm: "Project Management", pcb: "PCB & Firmware" };
const ROOT_PATH = "/" + ROOT_CHAIN.join("/") + "/";

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Folder names drift (spacing, ampersands, case) — match on the letters.

   `strict` turns the fuzzy half off. It is used when the name being tried is a
   GUESS reassembled from several path segments: there, a loose match is worse
   than no match, because "Project Management - Project Managers / Eb-09-1752"
   contains the parent's name and would happily match the parent, swallowing
   the segment that named the folder actually wanted. */
async function childFolder(token: string, parentId: string, name: string, strict = false): Promise<GFile | null> {
  let kids: GFile[];
  try { kids = (await listChildren(token, parentId)).filter(isFolder); } catch { return null; }
  const n = norm(name);
  const exact = kids.find((k) => norm(k.name) === n);
  if (exact || strict) return exact || null;
  return kids.find((k) => norm(k.name).includes(n) || n.includes(norm(k.name))) || null;
}

/* Resolved once per warm instance — the IDs don't move.
   `all` is every folder directly under Engineering Services, because project
   work is not only in the two obvious ones: board folders live under
   Eb-Hardware, firmware under its own, and new ones appear over time. Naming
   two branches and hoping was why boards came back empty.                    */
let branchCache: { pm: GFile | null; pcb: GFile | null; all: GFile[]; ok: boolean } | null = null;
async function resolveBranches(token: string) {
  if (branchCache) return branchCache;
  const top = await searchFolders(token, ROOT_CHAIN[0]);
  let node: GFile | null = top.find((f) => norm(f.name) === norm(ROOT_CHAIN[0])) || top[0] || null;
  for (let i = 1; node && i < ROOT_CHAIN.length; i++) node = await childFolder(token, node.id, ROOT_CHAIN[i]);
  const out = { pm: null as GFile | null, pcb: null as GFile | null, all: [] as GFile[], top: null as GFile | null, ok: !!node };
  // the very top of the tree, kept as a last-resort root: a project living
  // outside Engineering Services is still inside Eb-02-ODM, and "everything
  // under Eb-02-ODM" is what people mean when they say the ODM folder.
  out.top = top.find((f) => norm(f.name) === norm(ROOT_CHAIN[0])) || top[0] || null;
  if (node) {
    out.all = (await listSafe(token, node.id)).filter(isFolder);
    const pick = (name: string) => {
      const n = norm(name);
      return out.all.find((k) => norm(k.name) === n) || out.all.find((k) => norm(k.name).includes(n)) || null;
    };
    out.pm = pick(BRANCH.pm);
    out.pcb = pick(BRANCH.pcb);
  }
  if (out.ok) branchCache = out;   // never cache a lookup that failed or ran out of time
  return out;
}
/* Where to look, in order: the asker's usual branch, then the other named one,
   then every other branch under Engineering Services — and finally the top of
   Eb-02-ODM itself, so anything filed outside Engineering Services is still
   found rather than reported as invisible. */
function searchOrder(branches: { pm: GFile | null; pcb: GFile | null; all: GFile[]; top?: GFile | null }, scope: string): GFile[] {
  const first = scope === "pcb" ? [branches.pcb, branches.pm] : [branches.pm, branches.pcb];
  const seen = new Set<string>();
  const out: GFile[] = [];
  for (const f of [...first, ...branches.all, branches.top || null]) {
    if (f && !seen.has(f.id)) { seen.add(f.id); out.push(f); }
  }
  return out;
}

/* Where a search root actually lives. Every root except the last is a child of
   Engineering Services; the last one IS the top of Eb-02-ODM, and prefixing the
   chain onto it produced paths that did not exist. */
function rootPath(root: GFile, branches: { top?: GFile | null }): string {
  return root.id === branches.top?.id ? `/${root.name}/` : `${ROOT_PATH}${root.name}/`;
}

/* Find the folder for an ID somewhere under a branch. A level at a time, so a
   folder nested one deeper than expected is still found — but each level goes
   out in parallel and the breadth is capped, or a wide branch costs minutes. */
/* How well a folder name answers to an ID. Lower is better:
     0 the same name          1 the folder name contains the ID
     2 the ID contains the folder name — a last resort, because a board ID like
       <project>-PCB "contains" its parent project folder's name and would
       otherwise swallow the search before the real board folder is reached. */
function matchRank(folderName: string, n: string): number {
  const kn = norm(folderName);
  if (kn === n) return 0;
  if (kn.includes(n)) return 1;
  if (n.length >= 8 && kn.length >= 6 && n.includes(kn)) return 2;
  return 9;
}

async function findFolderUnder(token: string, root: GFile, needle: string, maxDepth = 2): Promise<{ hits: GFile[]; rank: number }> {
  const n = norm(needle);
  if (!n || n.length < 3) return { hits: [], rank: 9 };
  let level: GFile[] = [root];
  for (let d = 0; d < maxDepth && level.length && !outOfTime(); d++) {
    const lists = await inParallel(level.slice(0, 12), 8, (f: GFile) => listSafe(token, f.id));
    const scored: { f: GFile; r: number }[] = [], next: GFile[] = [];
    for (const kids of lists) {
      for (const k of kids) {
        if (!isFolder(k)) continue;
        const r = matchRank(k.name, n);
        if (r < 9) scored.push({ f: k, r });
        else next.push(k);
      }
    }
    if (scored.length) {
      scored.sort((a, b) => a.r - b.r);
      return { hits: scored.slice(0, 2).map((x) => x.f), rank: scored[0].r };
    }
    level = next;
  }
  return { hits: [], rank: 9 };
}

/* A search across a whole branch, for "find the checklists across the ODM
   management folder" — no single project in mind. Drive searches by name
   globally, so ask it once and keep only what actually lives under our chain,
   using the cached parent-chain walk to decide.                             */
async function searchUnder(token: string, rootName: string, term: string, limit = 10): Promise<GFile[]> {
  const t = term.trim();
  if (t.length < 3) return [];
  const q = encodeURIComponent(`name contains '${t.replace(/'/g, "\\'")}' and trashed = false`);
  let data: any;
  try {
    data = await drive(token, `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,parents,webViewLink)&pageSize=40&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
  } catch { return []; }
  /* Folders count. A project ID, a PCB ID and a board revision are all FOLDER
     names — "1880" is the tail of EbX-RD-01-01-03-1880-GW-123 — so excluding
     folders from a search made the commonest question in this system
     ("find 1880") unanswerable, and the honest "I found nothing" that came
     back was the function's fault, not the asker's. */
  const files: GFile[] = (data.files ?? []);
  const under = await inParallel(files.slice(0, 16), 6, async (f: GFile) => {
    const path = await folderPath(token, f).catch(() => "");
    return norm(path).includes(norm(rootName)) ? { ...f, _path: path } as GFile & { _path: string } : null;
  });
  return under.filter(Boolean).slice(0, limit) as GFile[];
}

type Entry = { f: GFile; path: string };
/* Everything inside the folder, all the way down — not just the first level.
   Level by level and in parallel, bounded by both a listing cap and the wall
   clock so a huge folder returns a partial tree instead of nothing at all.  */
async function walkTree(token: string, root: GFile, basePath: string, maxDepth = 4, maxEntries = 200, maxLists = 30) {
  const entries: Entry[] = [];
  let level: { f: GFile; path: string }[] = [{ f: root, path: basePath }];
  let listed = 0, truncated = false;
  for (let d = 0; d < maxDepth && level.length; d++) {
    if (outOfTime() || listed >= maxLists || entries.length >= maxEntries) { truncated = true; break; }
    const batch = level.slice(0, maxLists - listed);
    if (batch.length < level.length) truncated = true;
    listed += batch.length;
    const lists = await inParallel(batch, 8, (nd: { f: GFile; path: string }) => listSafe(token, nd.f.id));
    const next: { f: GFile; path: string }[] = [];
    lists.forEach((kids, i) => {
      const cur = batch[i];
      for (const k of kids) {
        if (entries.length >= maxEntries) { truncated = true; break; }
        entries.push({ f: k, path: cur.path });
        if (isFolder(k)) next.push({ f: k, path: `${cur.path}${k.name}/` });
      }
    });
    level = next;
  }
  return { entries, truncated: truncated || level.length > 0 };
}

/* Walk up the parent chain so the AI can quote the REAL Drive path
   (e.g. /My Drive/ODM/Projects/Eb-09-.../) instead of the assumed convention. */
const pathCache = new Map<string, string>();
async function folderPath(token: string, f: GFile): Promise<string> {
  if (pathCache.has(f.id)) return pathCache.get(f.id)!;
  const parts = [f.name];
  let parentId = f.parents?.[0];
  for (let depth = 0; depth < 6 && parentId; depth++) {
    try {
      const p: GFile = await drive(token, `files/${parentId}?fields=id,name,parents&supportsAllDrives=true`);
      if (!p?.name) break;
      parts.unshift(p.name);
      parentId = p.parents?.[0];
    } catch { break; }
  }
  const full = "/" + parts.join("/") + "/";
  pathCache.set(f.id, full);
  return full;
}

async function exportAs(token: string, id: string, mimeType: string, limit: number): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? (await res.text()).slice(0, limit) : "";
}

/* Office files (.xlsx/.docx/.pptx) and PDFs can't be exported directly, but
   Drive will convert them: copy the file into the matching Google format, read
   the text out, then delete the temporary copy. PDF→Doc conversion also OCRs.
   Needs Editor access on the folder, which we already require for writes. */
async function convertAndExtract(token: string, f: GFile, limit: number): Promise<string> {
  const m = f.mimeType || "";
  const name = f.name.toLowerCase();
  const asSheet = /spreadsheet|excel|\.xlsx?$|\.csv$/.test(m) || /\.xlsx?$/.test(name);
  const asDoc = /word|document|pdf|presentation|powerpoint/.test(m) || /\.(docx?|pdf|pptx?)$/.test(name);
  if (!asSheet && !asDoc) return "";
  const targetMime = asSheet ? "application/vnd.google-apps.spreadsheet" : "application/vnd.google-apps.document";
  let copyId = "";
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/copy?supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `~ebtmp-${f.name}`, mimeType: targetMime }),
    });
    if (!res.ok) return "";
    copyId = (await res.json()).id;
    return await exportAs(token, copyId, asSheet ? "text/csv" : "text/plain", limit);
  } catch {
    return "";
  } finally {
    // never leave temporary copies behind
    if (copyId) {
      try { await fetch(`https://www.googleapis.com/drive/v3/files/${copyId}?supportsAllDrives=true`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); } catch { /* ignore */ }
    }
  }
}

/* ── THE PROCESS MAP, READ LIVE FROM DRIVE ───────────────────────────────────
   The master process flow is a living document: it is edited in Drive, and the
   app has to follow it rather than carry a copy that quietly goes stale. A
   plan built from last month's method is worse than no plan, because nobody
   can tell by looking.

   Reading it needs the Sheets API rather than Drive's CSV export, because
   export only ever returns the FIRST tab and the map is spread across three —
   the steps, the template library, and the split/merge structure. The `drive`
   scope already covers the Sheets API, so no new permission is involved.

   An .xlsx is not a Sheet, so it is copied into one, read, and the copy
   deleted — the same trick the text extractor uses, and the reason writes need
   Editor rather than Viewer.                                                 */
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

async function readSheets(token: string, id: string, ranges: string[]): Promise<Record<string, string[][]>> {
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${qs}&majorDimension=ROWS`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheets API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const out: Record<string, string[][]> = {};
  for (const vr of data.valueRanges ?? []) {
    // "'Process Flow'!A1:P400" → "Process Flow"
    const name = String(vr.range || "").replace(/^'?(.*?)'?!.*$/, "$1");
    out[name] = (vr.values ?? []) as string[][];
  }
  return out;
}

/* Read the three tabs, converting first when the file is an .xlsx. */
async function readProcessWorkbook(token: string, f: GFile, ranges: string[]) {
  if (f.mimeType === SHEET_MIME) return await readSheets(token, f.id, ranges);

  let copyId = "";
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/copy?supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `~ebtmp-process-${Date.now()}`, mimeType: SHEET_MIME }),
    });
    if (!res.ok) throw new Error(`Drive would not convert the workbook (${res.status}). The service account needs Editor on that folder.`);
    copyId = (await res.json()).id;
    return await readSheets(token, copyId, ranges);
  } finally {
    if (copyId) {
      try { await fetch(`https://www.googleapis.com/drive/v3/files/${copyId}?supportsAllDrives=true`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); } catch { /* never leave a copy behind */ }
    }
  }
}

async function extractText(token: string, f: GFile, limit = 1800): Promise<string> {
  try {
    if (f.mimeType === "application/vnd.google-apps.document") return await exportAs(token, f.id, "text/plain", limit);
    if (f.mimeType === "application/vnd.google-apps.spreadsheet") return await exportAs(token, f.id, "text/csv", limit);
    if (f.mimeType === "application/vnd.google-apps.presentation") return await exportAs(token, f.id, "text/plain", limit);
    if (/^text\/|json|csv/.test(f.mimeType) && Number(f.size || 0) < 200_000) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.text()).slice(0, limit);
    }
    // .xlsx / .docx / .pdf / .pptx — convert, read, clean up
    if (Number(f.size || 0) < 15_000_000) return await convertAndExtract(token, f, limit);
  } catch { /* best effort */ }
  return "";
}

/* ── WRITE ─────────────────────────────────────────────────────────────────
   Create (or overwrite) a text/markdown file inside the project's Drive
   folder. Used to push closure evidence, status notes and AI analyses back to
   /ODM/PM/<ProjectID>/. Requires the folder shared as Editor.               */
/* Base64 → bytes, a slice at a time. atob() on a 60 MB string would build a
   60-million-character binary string first (twice that in memory) before we
   ever got an array; decoding in chunks keeps the peak down. */
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  const CHUNK = 8192 * 4;                       // a multiple of 4 — never split a quad
  let at = 0;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const bin = atob(clean.slice(i, i + CHUNK));
    for (let j = 0; j < bin.length; j++) out[at++] = bin.charCodeAt(j);
  }
  return out.subarray(0, at);
}

/* Google's write failures are JSON blobs. Turn the ones that actually happen
   into a sentence someone can act on, instead of pasting the blob into a chat. */
async function writeFailureReason(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  let msg = "";
  try { msg = JSON.parse(raw)?.error?.message || ""; } catch { msg = ""; }
  const m = (msg || raw).toLowerCase();
  if (m.includes("storage quota")) {
    return IMPERSONATE
      ? `Google won't let ${IMPERSONATE} own this file — check that account has Drive space and that domain-wide delegation is switched on for the service account.`
      : "Drive won't accept files from the service account, because a service account has no storage of its own. Either move the ODM folders into a Shared Drive, or set GOOGLE_IMPERSONATE_USER on the function to a real person in your Workspace.";
  }
  if (res.status === 403) return "The service account can read this folder but not write to it — share it as an Editor rather than a Viewer.";
  if (res.status === 404) return "That folder isn't reachable — check it is still shared with the service account.";
  if (res.status === 413) return "The file is too large for Drive to take this way.";
  return (msg || `Drive refused the write (${res.status})`).slice(0, 160);
}

/* Make a folder if it is not there. Returns the folder either way. */
async function createFolder(token: string, parentId: string, name: string): Promise<GFile | null> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!res.ok) return null;
  return await res.json() as GFile;
}

/* ── Renaming a file that already exists ─────────────────────────────────────
   Uploading was only half the job: "rename that" was a dead end, and being
   told to go and do it in Drive by hand defeats the point of asking. The
   rename itself is one PATCH; the work is FINDING the file the person means.

   Deletion is deliberately absent. Nothing reachable from a chat message
   should be able to remove a file from Drive on a misread instruction — that
   stays a deliberate act, done by a person, in Drive.                        */

/* Find one file by name inside a folder. Exact match wins; otherwise a unique
   partial match, so "the LLD" finds "Eb-21-EL-287-01-1846 - LLD.docx". An
   ambiguous name returns every candidate so the caller can ask which. */
async function findFileIn(token: string, folderId: string, name: string): Promise<{ hit: GFile | null; candidates: GFile[] }> {
  const kids = (await listChildren(token, folderId))
    .filter((f) => f.mimeType !== "application/vnd.google-apps.folder");
  const want = norm(name);
  const exact = kids.find((f) => norm(f.name) === want);
  if (exact) return { hit: exact, candidates: [] };
  const partial = kids.filter((f) => norm(f.name).includes(want) || want.includes(norm(f.name)));
  if (partial.length === 1) return { hit: partial[0], candidates: [] };
  return { hit: null, candidates: partial.length ? partial : kids.slice(0, 12) };
}

async function renameFile(token: string, fileId: string, newName: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) throw new Error(`rename failed: ${(await res.text()).slice(0, 200)}`);
}

async function writeFile(token: string, folderId: string, name: string, content: string, mimeType = "text/plain", encoding = ""): Promise<string> {
  // Replace an existing file of the same name so re-writes don't duplicate.
  const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`);
  const existing = await drive(token, `files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const prevId = existing.files?.[0]?.id;

  const boundary = "ebodm" + Math.random().toString(36).slice(2);
  const metadata: Record<string, unknown> = prevId ? { name } : { name, parents: [folderId] };
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;

  // encoding "base64" carries a real binary — a PDF, a spreadsheet, a 40 MB
  // photo. Decode it to bytes and send those: passing the base64 through in
  // the body would be a third larger and would hold the whole file in a
  // single JavaScript string, which a big upload cannot afford.
  const body: BodyInit = encoding === "base64"
    ? new Blob([pre, decodeBase64(content), post])
    : `${pre}${content}${post}`;

  const url = prevId
    ? `https://www.googleapis.com/upload/drive/v3/files/${prevId}?uploadType=multipart&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;
  const res = await fetch(url, {
    method: prevId ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(await writeFailureReason(res));
  const data = await res.json();
  return data.id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SA_EMAIL || !SA_KEY) return json({ error: "Google service-account secrets not set" }, 500);

  // Body is parsed regardless of content-type (the app sends text/plain so the
  // same call also works against the Apps Script backend without a preflight).
  let body: { projectId?: string; linkedIds?: string[]; token?: string; action?: string; fileName?: string; content?: string; mimeType?: string; encoding?: string; scope?: string; search?: string; userJwt?: string; folderPath?: string; newName?: string };
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "invalid JSON body" }, 400); }
  const expected = Deno.env.get("DRIVE_READ_TOKEN") ?? "";
  if (expected && body.token !== expected) return json({ error: "unauthorized" }, 401);
  const needles = [body.projectId, ...(body.linkedIds ?? [])].filter(Boolean) as string[];
  // No project named is a legitimate question ("find the checklists across the
  // ODM folder") as long as there is something to search for — it used to be a
  // flat 400.
  // browsing needs neither a project nor a search term — the folder IS the ask
  if (!needles.length && !String(body.search || "").trim()
      && !["write", "list", "rename", "read_file"].includes(String(body.action || ""))) {
    return json({ ok: true, digest: "", note: "no project or search term given" });
  }

  // Fresh listings and a fresh clock for every request.
  kidsCache = new Map();
  deadline = Date.now() + BUDGET_MS;

  // Act as the signed-in person when we can, so uploads carry their name.
  const who = await callerEmail(req, body.userJwt);
  const actingAs = subjectFor(who);

  try {
    const token = await getAccessToken(actingAs);

    /* Walk a slash-separated path down from Eb-02-ODM. `make` creates the
       folders that are missing; without it a missing folder just stops the
       walk and the caller is told how far it got. */
    /* `last` is the deepest folder that DID exist when a walk dies — the
       caller uses it to say what's actually in there instead of a bare 404. */
    const walkPath = async (rawPath: string, make: boolean) => {
      const parts = rawPath.split("/").map((x) => x.trim()).filter(Boolean);
      const top = await searchFolders(token, ROOT_CHAIN[0]);
      let node: GFile | null = top.find((f) => norm(f.name) === norm(ROOT_CHAIN[0])) || top[0] || null;
      if (!node) return { node: null, walked: [] as string[], missing: ROOT_CHAIN[0], last: null as GFile | null };
      const walked: string[] = [ROOT_CHAIN[0]];
      // a path that does not start at the top is taken from Engineering Services
      if (parts.length && norm(parts[0]) === norm(ROOT_CHAIN[0])) parts.shift();
      else if (parts.length) {
        for (let i = 1; node && i < ROOT_CHAIN.length; i++) {
          const next = await childFolder(token, node.id, ROOT_CHAIN[i]);
          if (next) { node = next; walked.push(next.name); } else { node = null; }
        }
        if (!node) return { node: null, walked, missing: ROOT_CHAIN.join("/"), last: null as GFile | null };
      }
      /* Drive is not a filesystem: a folder's own name may contain a slash, and
         two of ours do — "PCB & Firmware - Engineers / Developers" and
         "Z-Engineering Modules / Frameworks / Sigma Backend". Splitting the
         path on "/" tears those in half, so at each level try the LONGEST run
         of remaining segments first and fall back to shorter ones.

         Longest-first is not a preference, it is required: "PCB & Firmware -
         Engineers" alone would fuzzy-match the real folder, consume one
         segment, and leave "Developers" to fail against its children. */
      for (let i = 0; i < parts.length; ) {
        let found: GFile | null = null;
        let used = 1;
        for (let take = Math.min(4, parts.length - i); take >= 1; take--) {
          const name = parts.slice(i, i + take).join(" / ");
          // Only the single segment the caller actually wrote may match loosely.
          const kid = await childFolder(token, node!.id, name, take > 1);
          if (kid) { found = kid; used = take; break; }
        }
        // Creating is different: make exactly the one folder that was asked
        // for, never a speculative multi-segment name.
        if (!found && make) { found = await createFolder(token, node!.id, parts[i]); used = 1; }
        if (!found) return { node: null, walked, missing: parts[i], last: node };
        node = found;
        walked.push(node.name);
        i += used;
      }
      return { node, walked, missing: "", last: node };
    };

    /* ── list action: what is actually in a folder ──
       Browsing is not searching. "What is in Eb-02-ODM" is a fair question and
       used to be answered with "I don't have visibility there", because the
       only tool was a search confined to the Engineering Services branches. */
    /* ── the process map, straight from the Drive file ──────────────────────
       The workbook is the company's method and it is maintained in Drive, so
       this reads it there rather than shipping a copy. It returns the parsed
       map plus WHERE it came from and when that file was last touched, so the
       app can say "synced from Drive, edited 3 days ago" instead of asking
       anyone to take a number on trust. */
    if (body.action === "process_map") {
      const want = String(body.name || "Master Process Flow");
      const found = await searchUnder(token, ROOT_CHAIN[0], want, 20);
      /* Prefer the copy that actually sits in a Process folder — old versions
         of this workbook exist, and one under Archive must never win. Then
         prefer the most recently edited, because the live method is the one
         somebody touched last. */
      const ranked = (await inParallel(found, 6, async (f: GFile) => {
        const path = (f as GFile & { _path?: string })._path || await folderPath(token, f).catch(() => "");
        const inProcess = /\/process[^/]*\//i.test(path);
        const archived = /\/(99-)?archive|\/old\b|\/backup/i.test(path);
        return { f, path, score: (inProcess ? 2 : 0) - (archived ? 3 : 0), at: f.modifiedTime || "" };
      }))
        .filter((x) => /\.xlsx?$/i.test(x.f.name) || x.f.mimeType === SHEET_MIME)
        .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));

      if (!ranked.length) {
        return json({ error: `I couldn't find a workbook called "${want}" anywhere the service account can see. Share the Process folder with ${SA_EMAIL} and try again.` }, 404);
      }
      const pick = ranked[0];

      let tabs: Record<string, string[][]>;
      try {
        tabs = await readProcessWorkbook(token, pick.f, [
          // The Flow Map grew a second section below the block table — the
          // cross-track convergence points — and a range that stopped at row
          // 40 would have cut it off without anything saying so.
          "'Process Flow'!A1:P400", "'Template Actions'!A1:G300", "'Flow Map'!A1:F80",
        ]);
      } catch (e) {
        return json({ error: `Found ${pick.f.name} but could not read it: ${e}` }, 502);
      }

      const cell = (r: string[] | undefined, i: number) => String(r?.[i] ?? "").replace(/\s+/g, " ").trim();
      const flowRows = tabs["Process Flow"] ?? [];
      const steps = [];
      for (let i = 5; i < flowRows.length; i++) {
        const r = flowRows[i];
        const no = Number(cell(r, 0));
        if (!Number.isFinite(no) || !cell(r, 2)) continue;
        steps.push({
          no, category: cell(r, 1), step: cell(r, 2),
          entryTrigger: cell(r, 3), exitTrigger: cell(r, 4),
          entryQuestion: cell(r, 5), exitQuestion: cell(r, 6),
          // 35 rows have the template id glued onto the front of the
          // filename. It is already in its own column, and left in it makes
          // every one of those steps name a file Drive will never match.
          templateFile: cell(r, 7).replace(/^EB-T-\d+\s*[·|:-]\s*/, ""),
          templateId: cell(r, 8), template: cell(r, 9),
          action: cell(r, 11), whatToDo: cell(r, 12),
          owner: cell(r, 13), responsibility: cell(r, 14), guidelines: cell(r, 15),
        });
      }
      if (!steps.length) {
        return json({ error: `${pick.f.name} opened but its "Process Flow" tab has no step rows — has the layout changed?` }, 502);
      }

      const templates: Record<string, unknown> = {};
      for (const r of (tabs["Template Actions"] ?? []).slice(4)) {
        const id = cell(r, 0);
        if (!/^EB-T-/.test(id)) continue;
        templates[id] = {
          id, name: cell(r, 1), folder: cell(r, 3),
          steps: cell(r, 4).split(",").map((x) => Number(x.trim())).filter(Number.isFinite),
          actions: cell(r, 6).split("·").map((x) => x.trim()).filter(Boolean),
        };
      }

      /* ── the Flow Map, read whole ─────────────────────────────────────────
         This tab names the major blocks and fixes the sequence they run in,
         and underneath the block table it names the points where the three
         parallel design tracks have to stop and agree with each other.

         Sections are found by their own headers rather than by row number, so
         a row inserted in Drive cannot silently shift what gets read — and
         every non-empty row that no section claims comes back in `unread`
         instead of being dropped. */
      const blocks = [];
      const convergence = [];
      const unread: string[] = [];
      {
        const fmRows = tabs["Flow Map"] ?? [];
        let section = "";
        for (let i = 0; i < fmRows.length; i++) {
          const r = fmRows[i] ?? [];
          const c = r.map((x) => String(x ?? "").replace(/\s+/g, " ").trim());
          if (!c.some(Boolean)) continue;
          if (c[0] === "Block" && /categor/i.test(c[1] || "")) { section = "blocks"; continue; }
          if (/convergence step/i.test(c[1] || "")) { section = "convergence"; continue; }
          if (/^cross-track convergence/i.test(c[0] || "")) { section = ""; continue; }
          if (i === 0 && /flow structure/i.test(c[0] || "")) continue;

          if (section === "blocks") {
            if (/^TOTAL$/i.test(c[0]) || /^TOTAL$/i.test(c[2])) { section = ""; continue; }
            if (!c[0] || !c[1]) { unread.push(`row ${i + 1}: ${c.filter(Boolean).join(" ").slice(0, 70)}`); continue; }
            const group = (c[0].match(/^([A-Z])\b/) || [])[1] || "X";
            const nth = blocks.filter((b) => b.group === group).length + 1;
            const name = (c[1].replace(/^\d+\s*·\s*/, "") || c[1]).trim();
            blocks.push({
              seq: blocks.length + 1, id: `${group}${nth}`, group,
              kind: c[0].replace(/^[A-Z]\s*[—–-]\s*/, "").trim() || "Serial",
              name, label: `${group}${nth} · ${name}`,
              block: c[0], category: c[1], sourceRows: c[2] || "",
              steps: Number(c[3]) || 0, runs: c[4] || "", convergesWith: c[5] || "",
            });
            continue;
          }
          if (section === "convergence") {
            if (!c[1]) { unread.push(`row ${i + 1}: ${c.filter(Boolean).join(" ").slice(0, 70)}`); continue; }
            convergence.push({
              n: Number(c[0]) || convergence.length + 1,
              name: c[1].replace(/\s*\(row\s*\d+\)\s*$/i, "").trim(),
              tracks: c[2] || "", agree: c[3] || "", merge: /merge/i.test(c[2] || ""), steps: [],
            });
            continue;
          }
          if (c.filter(Boolean).length === 1 && c[0] && c[0].length > 30) continue;
          unread.push(`row ${i + 1}: ${c.filter(Boolean).join(" ").slice(0, 70)}`);
        }
        // A block whose category carries a qualifier the Process Flow tab does
        // not use — "3 · Test (per track)" against "3 · Test" — is the same
        // category drawn twice, not a missing one.
        const known = new Set(steps.map((s) => s.category));
        for (const b of blocks) {
          if (known.has(b.category)) continue;
          const stem = b.category.replace(/\s*\([^)]*\)\s*$/, "");
          if (known.has(stem)) b.category = stem;
        }
      }

      /* ── the template register ────────────────────────────────────────────
         A separate workbook, and the only place that knows where a template's
         filled-in copy actually goes, what it should be called and what good
         looks like. It also defines templates the master workbook uses but
         never declares, so without it those steps have no folder at all.

         Best effort by design: if it cannot be found the process map is still
         worth having, and the response says which one you got.               */
      let templateIndex: { name: string; path: string; count: number } | null = null;
      try {
        const idxFound = await searchUnder(token, ROOT_CHAIN[0], String(body.templateIndex || "TemplateIndex"), 10);
        const idxRanked = (await inParallel(idxFound, 4, async (f: GFile) => {
          const path = (f as GFile & { _path?: string })._path || await folderPath(token, f).catch(() => "");
          return { f, path, archived: /\/(99-)?archive|\/old\b|\/backup/i.test(path) };
        }))
          .filter((x) => !x.archived && (/\.xlsx?$/i.test(x.f.name) || x.f.mimeType === SHEET_MIME))
          .sort((a, b) => String(b.f.modifiedTime || "").localeCompare(String(a.f.modifiedTime || "")));
        if (idxRanked.length) {
          const ip = idxRanked[0];
          const itabs = await readProcessWorkbook(token, ip.f, ["'Index'!A1:R400"]);
          let n = 0;
          for (const r of itabs["Index"] ?? []) {
            const id = cell(r, 0);
            if (!/^EB-T-/.test(id)) continue;
            const instance = cell(r, 9);
            /* A file is not a folder, and a few rows put the filename in this
               column. The library column has the folder in those cases, one
               segment deeper because it is written from the top of the project
               rather than from inside it — so that root comes off. */
            const library = cell(r, 8).replace(/^0[12]-(Project-ID-Folder-PM|PCB-ID-Folder-Engineering)\//, "");
            const folder = /\.[a-z0-9]{2,5}$/i.test(instance) ? library : instance;
            const existing = (templates[id] ?? {}) as Record<string, unknown>;
            templates[id] = {
              ...existing,
              id,
              name: (existing.name as string) || cell(r, 1),
              // The index carries the real Drive folder names where the master
              // workbook uses shorthand stems, so it wins on the folder.
              folder: folder || (existing.folder as string) || "",
              steps: (existing.steps as number[]) || [],
              actions: (existing.actions as string[]) || [],
              format: cell(r, 3), kind: cell(r, 4),
              description: cell(r, 5), whatGood: cell(r, 6), serves: cell(r, 7),
              library: cell(r, 8), instanceName: cell(r, 10), stage: cell(r, 11),
              owner: cell(r, 14), filledBy: cell(r, 15), auditRow: cell(r, 16), version: cell(r, 17),
            };
            n++;
          }
          if (n) templateIndex = { name: ip.f.name, path: ip.path, count: n };
        }
      } catch { /* the master workbook alone is still a usable process map */ }

      return json({
        ok: true,
        steps, templates, blocks, convergence,
        // Rows on the Flow Map that no section claimed. Empty is the normal
        // answer; anything in here is a row somebody added that nothing reads.
        unread,
        templateIndex,
        // Provenance, so nobody has to guess whether the plan reflects the
        // current method — and a link that opens the file to edit it.
        file: {
          id: pick.f.id, name: pick.f.name, modifiedTime: pick.f.modifiedTime || "",
          path: pick.path,
          editLink: pick.f.webViewLink || `https://drive.google.com/open?id=${pick.f.id}`,
        },
        // Say what else is out there. When two copies of the method exist,
        // knowing which one was NOT used matters.
        alternates: ranked.slice(1, 4).map((x) => ({ name: x.f.name, path: x.path, modifiedTime: x.f.modifiedTime || "" })),
      });
    }

    /* ── the file a process step writes to ──────────────────────────────────
       Templates are pre-stored in each project and PCB-ID folder, so nothing
       here creates anything. The job is to FIND the file the step is about and
       hand back a link, so somebody can do the work without opening Drive to
       hunt for it first.

       Finding it is the whole problem. The workbook says the file should be
       called [ProjectID]_LLD-for-developer_v1.0 in 02-Hardware/00-Design/, but
       the crawl behind the sitemaps found the same folder under three
       different names across 122 projects and half the template files still
       named "blank file.docx". So this matches on the letters, walks folder
       names by stem, and when it cannot be sure it says what IS there rather
       than reporting nothing.                                                */
    if (body.action === "step_file") {
      const projectId = String(body.projectId || "").trim();
      const rel = String(body.folder || "").replace(/^\/+|\/+$/g, "");
      const fileName = String(body.fileName || "").trim();
      if (!projectId || !fileName) return json({ error: "Tell me the project and which file the step produces." }, 400);

      // The project's own folder, in whichever branch it lives.
      const branches = await resolveBranches(token);
      const roots = [branches.pm, branches.pcb, ...(branches.all || []), branches.top].filter(Boolean) as GFile[];
      let projectFolder: GFile | null = null;
      for (const r of roots) {
        projectFolder = await childFolder(token, r.id, projectId);
        if (projectFolder) break;
      }
      if (!projectFolder) {
        return json({ error: `No folder called ${projectId} under ${ROOT_PATH} — the project folder has to exist before its files can be opened.` }, 404);
      }

      // Down the template's own sub-path. Missing a level is worth saying
      // precisely: "07-Test-and-Compliance is not there yet" is actionable,
      // "file not found" is not.
      let node: GFile = projectFolder;
      // The full Drive path, not one relative to the project — somebody has to
      // be able to follow it in Drive, and "/03-LLD-HLD/" alone leads nowhere.
      const base = (await folderPath(token, projectFolder).catch(() => `/${projectFolder.name}/`))
        .replace(/^\/|\/$/g, "");
      const walked: string[] = base.split("/").filter(Boolean);
      for (const part of rel.split("/").filter(Boolean)) {
        const next = await childFolder(token, node.id, part);
        if (!next) {
          return json({
            ok: true, found: false, projectFolder: projectFolder.name,
            missingFolder: part, path: "/" + walked.join("/") + "/",
            reason: `${projectId} has no "${part}" folder under /${walked.join("/")}/ yet.`,
          });
        }
        node = next;
        walked.push(node.name);
      }

      /* The name in the workbook is [ProjectID]_Template-Name_v1.0, and half
         the files in these folders are saved as something else — "Milestone
         Tracking Sheet FINAL", "blank file.docx". Matching only on the full
         expected name finds none of those, so fall back to the DISTINCTIVE
         middle of the name, and then to the template's own library name. Both
         are still specific enough not to collide inside one folder. */
      const core = fileName
        .replace(new RegExp(`^${projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_-]*`, "i"), "")
        .replace(/_v\d+(\.\d+)*$/i, "")
        .replace(/\.[a-z0-9]{2,5}$/i, "");
      let { hit, candidates } = await findFileIn(token, node.id, fileName);
      if (!hit && core.length > 4) ({ hit, candidates } = await findFileIn(token, node.id, core));
      if (!hit && body.template) ({ hit, candidates } = await findFileIn(token, node.id, String(body.template)));
      if (!hit) {
        return json({
          ok: true, found: false, projectFolder: projectFolder.name,
          folderId: node.id, path: "/" + walked.join("/") + "/",
          reason: `Nothing in /${walked.join("/")}/ matches "${fileName}".`,
          // What IS in there. Half these folders hold a file under a name
          // nobody expected, and showing them turns a dead end into a choice.
          candidates: candidates.map((f) => ({
            id: f.id, name: f.name, modifiedTime: f.modifiedTime || "",
            openLink: f.webViewLink || `https://drive.google.com/open?id=${f.id}`,
          })),
        });
      }

      /* Open vs download are different links. A Google-native file opens in
         its editor and downloads through an export; an .xlsx or .docx sitting
         in Drive downloads directly. Getting this wrong hands someone a link
         that 404s at the moment they need the file. */
      const native = (hit.mimeType || "").startsWith("application/vnd.google-apps.");
      const kind = /spreadsheet/.test(hit.mimeType || "") ? "spreadsheets"
        : /presentation/.test(hit.mimeType || "") ? "presentation" : "document";
      const asFormat = kind === "spreadsheets" ? "xlsx" : kind === "presentation" ? "pptx" : "docx";
      return json({
        ok: true, found: true,
        projectFolder: projectFolder.name,
        file: {
          id: hit.id, name: hit.name, mimeType: hit.mimeType,
          modifiedTime: hit.modifiedTime || "", size: hit.size || "",
          path: "/" + walked.join("/") + "/" + hit.name,
          openLink: hit.webViewLink || `https://drive.google.com/open?id=${hit.id}`,
          downloadLink: native
            ? `https://docs.google.com/${kind}/d/${hit.id}/export?format=${asFormat}`
            : `https://drive.google.com/uc?export=download&id=${hit.id}`,
        },
        // The name differs from what the workbook expects — worth flagging,
        // because that drift is why folder conformance reads low.
        renamed: norm(hit.name) !== norm(fileName) ? fileName : "",
      });
    }

    if (body.action === "list") {
      const rawPath = String(body.folderPath || "").trim().replace(/^\/+|\/+$/g, "");
      const { node, walked, missing, last } = await walkPath(rawPath, false);
      if (!node) {
        if (missing === ROOT_CHAIN[0]) {
          return json({ error: `I can't see ${ROOT_CHAIN[0]} in Drive at all — share it with the service account.` }, 404);
        }
        // "Not found" alone sends the caller away with nothing. Say what IS
        // in the deepest folder we reached, closest names first, so the next
        // step is obvious instead of a guessing game: project folders rarely
        // carry the full formal ID — often just the tail number or the name.
        const siblings = last ? (await listSafe(token, last.id)).filter(isFolder).map((k) => k.name) : [];
        const tail = (missing.match(/\d{3,}/g) || []).pop() || "";
        const nm = norm(missing);
        const score = (n: string) => {
          const nn = norm(n);
          if (nn === nm) return 0;
          if (tail && nn.includes(tail)) return 1;         // same project number
          if (nn.includes(nm) || nm.includes(nn)) return 2;
          const head = nm.slice(0, 12);
          if (head && nn.startsWith(head)) return 3;       // same ID family
          return 9;
        };
        const near = siblings.filter((n) => score(n) < 9).sort((a, b) => score(a) - score(b)).slice(0, 5);
        return json({
          error: `There's no folder called "${missing}" under /${walked.join("/")}/.`
            + (near.length
              ? ` Closest existing folder(s): ${near.map((n) => `"${n}"`).join(", ")} — one of these is probably it.`
              : siblings.length
                ? ` That folder holds ${siblings.length} folder(s); none look related. List it to see them all.`
                : ""),
          nearby: near, siblings: siblings.length,
        }, 404);
      }
      const kids = await listSafe(token, node.id);
      const folders = kids.filter(isFolder).map((k) => k.name).sort();
      const files = kids.filter((k) => !isFolder(k)).map((k) => k.name).sort();
      return json({
        ok: true,
        path: `/${walked.join("/")}/`,
        folders, files,
        listing: [
          `/${walked.join("/")}/ holds ${folders.length} folder(s) and ${files.length} file(s).`,
          ...folders.map((n) => `  [folder] ${n}`),
          ...files.map((n) => `  ${n}`),
        ].join("\n"),
      });
    }

    // ── write action: { action:"write", projectId | folderPath, fileName, content } ──
    if (body.action === "write") {
      if (!body.fileName || body.content == null) return json({ error: "fileName and content required" }, 400);

      /* An explicit path writes anywhere the service account can reach, not
         only inside a project folder. "Eb-02-ODM/Templates" walks down from the
         top; a bare "Templates" is taken as relative to Engineering Services.
         Missing folders along the way are created, so "put it in a new
         Templates folder" is one instruction rather than a trip to Drive. */
      const rawPath = String(body.folderPath || "").trim().replace(/^\/+|\/+$/g, "");
      if (rawPath) {
        const { node, walked, missing } = await walkPath(rawPath, true);
        if (!node) return json({ error: `I couldn't open or create "${missing}" under /${walked.join("/")}/` }, 502);
        const fid = await writeFile(token, node.id, String(body.fileName), String(body.content), body.mimeType || "text/plain", body.encoding || "");
        return json({ ok: true, fileId: fid, folder: node.name, path: `/${walked.join("/")}/`, savedAs: actingAs || "" });
      }

      // Same address, and the same best-match rule, as the read side — so a
      // file lands in the folder the reader is actually looking at.
      const br = await resolveBranches(token);
      let folders: GFile[] = [];
      let best = 9;
      for (const root of searchOrder(br, String(body.scope || "pm"))) {
        if (outOfTime()) break;
        const { hits, rank } = await findFolderUnder(token, root, String(body.projectId), root.id === br.top?.id ? 4 : 2);
        if (hits.length && rank < best) { best = rank; folders = hits; }
        if (best === 0) break;
      }
      if (!folders.length) folders = await findFolders(token, String(body.projectId));
      if (!folders.length) {
        // A project folder is often named by its tail number alone. Look for
        // that before giving up — but for a WRITE, never guess silently: name
        // the candidates and let the caller aim the next call precisely.
        const tail = (String(body.projectId).match(/\d{3,}/g) || []).pop() || "";
        const maybe = tail ? (await findFolders(token, tail)).map((f) => f.name).slice(0, 4) : [];
        return json({ error: `I couldn't find a folder called ${body.projectId} anywhere under ${ROOT_PATH}`
          + (maybe.length
            ? ` — but ${maybe.map((n) => `"${n}"`).join(", ")} exist(s); if one of those is this project, write again with that folder as folderPath.`
            : ` — if the folder exists under another name, list its parent to find it; otherwise share it (Editor) with ${SA_EMAIL}.`),
          nearby: maybe, serviceAccount: SA_EMAIL }, 404);
      }
      const id = await writeFile(token, folders[0].id, String(body.fileName), String(body.content), body.mimeType || "text/plain", body.encoding || "");
      return json({ ok: true, fileId: id, folder: folders[0].name, savedAs: actingAs || "" });
    }

    /* Where a file-level action should look: an explicit path, else the
       project's folder, found the same way writing finds it — so "rename the
       file you just saved" looks exactly where it was just saved. */
    const locateFolder = async (b: typeof body, tk: string): Promise<{ folder: GFile; where: string } | { error: string }> => {
      const raw = String(b.folderPath || "").trim().replace(/^\/+|\/+$/g, "");
      if (raw) {
        const { node, walked, missing, last } = await walkPath(raw, false);
        if (!node) {
          const sibs = last ? (await listSafe(tk, last.id)).filter(isFolder).map((k) => k.name) : [];
          const t = (missing.match(/\d{3,}/g) || []).pop() || "";
          const near = sibs.filter((n) => (t && norm(n).includes(t)) || norm(n).includes(norm(missing)) || norm(missing).includes(norm(n))).slice(0, 4);
          return { error: `I couldn't open "${missing}" under /${walked.join("/")}/`
            + (near.length ? ` — closest folder(s) there: ${near.map((n) => `"${n}"`).join(", ")}.` : sibs.length ? ` — it holds ${sibs.length} folder(s); list it to see them.` : "") };
        }
        return { folder: node, where: `/${walked.join("/")}/` };
      }
      const br = await resolveBranches(tk);
      let pick: GFile | null = null, best = 9;
      for (const root of searchOrder(br, String(b.scope || "pm"))) {
        if (outOfTime()) break;
        const { hits, rank } = await findFolderUnder(tk, root, String(b.projectId), root.id === br.top?.id ? 4 : 2);
        if (hits.length && rank < best) { best = rank; pick = hits[0]; }
        if (best === 0) break;
      }
      if (!pick) pick = (await findFolders(tk, String(b.projectId)))[0] || null;
      if (!pick) {
        // Reads and renames may follow the tail number — the worst case is
        // reading the wrong folder and saying so, not writing into it.
        const tail = (String(b.projectId).match(/\d{3,}/g) || []).pop() || "";
        if (tail && tail !== String(b.projectId)) pick = (await findFolders(tk, tail))[0] || null;
        if (pick) return { folder: pick, where: `${pick.name} (matched by project number ${tail})` };
        return { error: `I couldn't find a folder called ${b.projectId} anywhere under ${ROOT_PATH} — if it exists under another name, list its parent to find it; otherwise share it (Editor) with ${SA_EMAIL}` };
      }
      return { folder: pick, where: pick.name };
    };

    // ── read_file: { action:"read_file", projectId | folderPath, fileName } ──
    // The digest gives ~1800 characters per file, which is right for "what is
    // in this folder" and useless for "change the third paragraph". This
    // returns one file whole, so editing can be a real read-then-write rather
    // than a guess.
    if (body.action === "read_file") {
      if (!body.fileName) return json({ error: "Tell me which file to read." }, 400);
      const f = await locateFolder(body, token);
      if ("error" in f) return json({ error: f.error }, 404);
      const { hit, candidates } = await findFileIn(token, f.folder.id, String(body.fileName));
      if (!hit) {
        return json({
          error: candidates.length
            ? `I couldn't pin down "${body.fileName}" in ${f.where}. Did you mean: ${candidates.map((c) => c.name).join(", ")}?`
            : `There's no file called "${body.fileName}" in ${f.where}.`,
          candidates: candidates.map((c) => c.name),
        }, 404);
      }
      const text = await extractText(token, hit, 100_000);
      // Whether the same bytes can be written BACK is a different question
      // from whether they can be read, and the caller needs to know which.
      const editable = /^text\/|json|csv/.test(hit.mimeType || "")
        || hit.mimeType === "application/vnd.google-apps.document";
      return json({
        ok: true, fileName: hit.name, mimeType: hit.mimeType, folder: f.where,
        text, editable,
        note: editable ? "" : `${hit.name} is a ${hit.mimeType?.split(".").pop() || "binary"} file — its text can be read but not written back in the same format.`,
      });
    }

    // ── rename: { action:"rename", projectId | folderPath, fileName, newName } ──
    if (body.action === "rename") {
      if (!body.fileName) return json({ error: "Tell me which file — its name." }, 400);
      if (!String(body.newName || "").trim()) {
        return json({ error: "Tell me what to rename it to." }, 400);
      }

      const loc = await locateFolder(body, token);
      if ("error" in loc) return json({ error: loc.error }, 404);
      const folder = loc.folder, where = loc.where;

      const { hit, candidates } = await findFileIn(token, folder.id, String(body.fileName));
      if (!hit) {
        // Naming the near-misses turns a dead end into one more question.
        return json({
          error: candidates.length
            ? `I couldn't pin down "${body.fileName}" in ${where}. Did you mean: ${candidates.map((c) => c.name).join(", ")}?`
            : `There's no file called "${body.fileName}" in ${where}.`,
          candidates: candidates.map((c) => c.name),
        }, 404);
      }

      const to = String(body.newName).trim();
      await renameFile(token, hit.id, to);
      return json({ ok: true, fileId: hit.id, from: hit.name, to, folder: where, savedAs: actingAs || "" });
    }

    // PMs look in Project Management first, engineers in PCB & Firmware —
    // but both branches are searched either way.
    const branches = await resolveBranches(token);
    const order = searchOrder(branches, String(body.scope || "pm"));
    const search = String(body.search || "").trim();

    const lines: string[] = [];
    // Every readable file we met, with its full path, so we can read the most
    // useful ones after the whole tree is mapped (not just the first folder's).
    const candidates: Entry[] = [];

    if (branches.ok) {
      const named = order.filter((f) => f.id !== branches.top?.id).map((f) => f.name);
      lines.push(`Looked across ${named.join(", ") || "its folders"} under ${ROOT_PATH}${branches.top ? `, and then the whole of /${ROOT_CHAIN[0]}/` : ""}.`);
    }

    // No project named — search the whole chain for what they asked about.
    if (!needles.length) {
      const hits = await searchUnder(token, ROOT_CHAIN[0], search);
      if (!hits.length) {
        lines.push(`Nothing named like "${search}" turned up anywhere under ${ROOT_PATH}.`);
      } else {
        const folders = hits.filter(isFolder);
        const files_ = hits.filter((f) => !isFolder(f));
        lines.push(`Searched the whole of ${ROOT_PATH} for "${search}" — ${hits.length} match(es) by name:`);
        for (const f of folders) {
          const path = (f as GFile & { _path?: string })._path || "";
          lines.push(`  FOLDER ${path || f.name}`);
        }
        for (const f of files_) {
          const path = (f as GFile & { _path?: string })._path || "";
          lines.push(`  ${path || f.name} · modified ${String(f.modifiedTime || "").slice(0, 10)}`);
          candidates.push({ f, path: path.replace(new RegExp(`${f.name}/$`), "") });
        }
        /* A matching FOLDER is almost always the real answer — somebody asking
           for "1880" wants the project, not a file that mentions it. So open
           the closest one and say what is in it, rather than naming it and
           making them ask a second time. */
        for (const dir of folders.slice(0, 2)) {
          const kids = await listSafe(token, dir.id);
          if (!kids.length) continue;
          const sub = kids.filter(isFolder).map((k) => k.name).sort();
          const inside = kids.filter((k) => !isFolder(k));
          lines.push(`  ↳ ${dir.name} holds ${sub.length} folder(s) and ${inside.length} file(s)`);
          if (sub.length) lines.push(`    folders: ${sub.slice(0, 25).join(" · ")}`);
          for (const f of inside.slice(0, 12)) {
            lines.push(`    ${f.name} · ${String(f.modifiedTime || "").slice(0, 10)}`);
            candidates.push({ f, path: ((dir as GFile & { _path?: string })._path || "") });
          }
        }
      }
    }

    // Each ID gets its own section with its own share of the digest, so a big
    // project folder can never crowd the linked boards out of the answer.
    const wanted = needles.slice(0, 4);
    const perSection = Math.floor(13000 / Math.max(1, wanted.length));

    for (const needle of wanted) {
      if (outOfTime()) { lines.push(`(stopped early — ${needle} and anything after it were not opened this time)`); break; }
      // The asker's branch, then the others, then anywhere in Drive.
      // Search every branch and keep the BEST match, not the first one found.
      // A board ID loosely resembles its parent project folder, so stopping at
      // the first branch used to hand back the project instead of the board.
      let folders: GFile[] = [];
      let where = "";
      let best = 9;
      for (const root of order) {
        if (outOfTime()) break;
        const { hits, rank } = await findFolderUnder(token, root, needle, root.id === branches.top?.id ? 4 : 2);
        if (hits.length && rank < best) { best = rank; folders = hits; where = rootPath(root, branches); }
        if (best === 0) break;                       // an exact name; nothing will beat it
      }
      if (!folders.length) { folders = await findFolders(token, needle); where = ""; }
      if (!folders.length) { lines.push(`Nothing found in Drive for ${needle} yet.`); continue; }

      const section: string[] = [];
      for (const folder of folders.slice(0, 2)) {
        // Always resolve the real parent chain. The search root is only the
        // right prefix when the hit is a direct child of it, which stopped
        // being true once the whole of Eb-02-ODM became searchable — and a
        // path that does not exist is worse than a slow one.
        const real = await folderPath(token, folder)
          .then((p) => p.replace(new RegExp(`${folder.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`), ""))
          .catch(() => "");
        // If Drive did not hand back enough parents to reach the top, the
        // chain is incomplete — fall back to the root we searched from rather
        // than printing a path that starts nowhere.
        const base = real.startsWith(`/${ROOT_CHAIN[0]}/`) ? real : (where || real);
        const path = `${base}${folder.name}/`;
        const { entries, truncated } = await walkTree(token, folder, path);
        const fileCount = entries.filter((e) => !isFolder(e.f)).length;
        section.push(`FOLDER ${folder.name} — real Drive path: ${path} · ${fileCount} file(s) in ${entries.filter((e) => isFolder(e.f)).length + 1} folder(s), listed in full below${folder.webViewLink ? ` · link: ${folder.webViewLink}` : ""}`);
        if (truncated) section.push(`  (very large folder — the listing below is the first ${entries.length} items)`);
        for (const e of entries) {
          section.push(`  ${e.path}${e.f.name}${isFolder(e.f) ? "/" : ""} · ${isFolder(e.f) ? "folder" : (e.f.mimeType || "").split(".").pop()} · modified ${String(e.f.modifiedTime || "").slice(0, 10)}`);
          if (!isFolder(e.f)) candidates.push(e);
        }
      }
      const text = section.join("\n");
      lines.push(text.length > perSection ? `${text.slice(0, perSection)}\n  (…rest of this folder's listing trimmed to leave room for the others)` : text);
    }

    // Read what is INSIDE the files, not just their names. Whatever the person
    // is actually asking about first, then the usual suspects (checklists,
    // reports, LLDs, BoMs…), then whatever changed most recently. Names are
    // never consistent, so this never depends on an exact filename.
    const terms = search.split(/\s+/).map(norm).filter((t) => t.length >= 3);
    const hit = (n: string) => terms.length > 0 && terms.some((t) => norm(n).includes(t));
    const score = (e: Entry) => (hit(e.f.name) || hit(e.path) ? 0 : /checklist|status|report|lld|note|bom|spec|minutes|plan|test|review/i.test(e.f.name) ? 1 : 2);
    candidates.sort((a, b) =>
      score(a) - score(b) ||
      String(b.f.modifiedTime || "").localeCompare(String(a.f.modifiedTime || "")));

    if (search) {
      const named = candidates.filter((e) => hit(e.f.name) || hit(e.path));
      lines.push(named.length
        ? `Looking for "${search}": ${named.length} file(s) match by name — their contents are below.`
        : `Looking for "${search}": nothing matches by name, so the most relevant files' contents are below — read them and answer from what is actually in them.`);
    }

    // Reading a file costs up to three round trips (Office and PDF are copied,
    // exported and deleted), so the best candidates go out together and the
    // clock stops the rest.
    // Round-robin by folder so every ID gets at least one file read — sorting
    // alone let one busy project take every slot.
    const byFolder = new Map<string, Entry[]>();
    for (const e of candidates) {
      const key = e.path.split("/").slice(0, 6).join("/");
      byFolder.set(key, [...(byFolder.get(key) || []), e]);
    }
    const shortlist: Entry[] = [];
    const budget = search ? 10 : 8;
    for (let round = 0; shortlist.length < budget; round++) {
      let added = false;
      for (const list of byFolder.values()) {
        if (shortlist.length >= budget) break;
        if (list[round]) { shortlist.push(list[round]); added = true; }
      }
      if (!added) break;
    }
    const texts = await inParallel(shortlist, 4, async (e: Entry) => ({ e, txt: await extractText(token, e.f) }));
    let extracts = 0;
    for (const { e, txt } of texts) {
      if (!txt) continue;
      lines.push(`  CONTENTS OF ${e.path}${e.f.name}: """${txt}"""`);
      extracts++;
    }
    if (outOfTime() && extracts < shortlist.length) lines.push(`(a few more files were not opened this time — ask again about a specific one and I'll read it)`);

    return json({ ok: true, digest: lines.join("\n").slice(0, 24000), root: branches.ok ? ROOT_PATH : "" });
  } catch (e) {
    // Log it too, so the reason is visible in the function's Logs tab and not
    // only in the response body.
    console.error("drive-read failed:", String(e));
    // The caller shows this to a person, so hand back the sentence, not the
    // "Error: {json blob}" wrapper.
    const clean = String((e as Error)?.message || e).replace(/^Error:\s*/, "").slice(0, 220);
    return json({ error: clean }, 500);
  }
});
