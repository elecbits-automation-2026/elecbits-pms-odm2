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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

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

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: SA_EMAIL,
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
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
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
const BRANCH: Record<string, string> = { pm: "Project Management", pcb: "PCB & Firmware" };
const ROOT_PATH = "/" + ROOT_CHAIN.join("/") + "/";

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Folder names drift (spacing, ampersands, case) — match on the letters. */
async function childFolder(token: string, parentId: string, name: string): Promise<GFile | null> {
  let kids: GFile[];
  try { kids = (await listChildren(token, parentId)).filter(isFolder); } catch { return null; }
  const n = norm(name);
  return kids.find((k) => norm(k.name) === n)
    || kids.find((k) => norm(k.name).includes(n) || n.includes(norm(k.name)))
    || null;
}

/* Resolved once per warm instance — the IDs don't move. */
let branchCache: { pm: GFile | null; pcb: GFile | null; ok: boolean } | null = null;
async function resolveBranches(token: string) {
  if (branchCache) return branchCache;
  const top = await searchFolders(token, ROOT_CHAIN[0]);
  let node: GFile | null = top.find((f) => norm(f.name) === norm(ROOT_CHAIN[0])) || top[0] || null;
  for (let i = 1; node && i < ROOT_CHAIN.length; i++) node = await childFolder(token, node.id, ROOT_CHAIN[i]);
  const out = { pm: null as GFile | null, pcb: null as GFile | null, ok: !!node };
  if (node) {
    out.pm = await childFolder(token, node.id, BRANCH.pm);
    out.pcb = await childFolder(token, node.id, BRANCH.pcb);
  }
  if (out.ok) branchCache = out;   // never cache a lookup that failed or ran out of time
  return out;
}

/* Find the folder for an ID somewhere under a branch. A level at a time, so a
   folder nested one deeper than expected is still found — but each level goes
   out in parallel and the breadth is capped, or a wide branch costs minutes. */
async function findFolderUnder(token: string, root: GFile, needle: string, maxDepth = 2): Promise<GFile[]> {
  const n = norm(needle);
  if (!n || n.length < 3) return [];
  let level: GFile[] = [root];
  for (let d = 0; d < maxDepth && level.length && !outOfTime(); d++) {
    const lists = await inParallel(level.slice(0, 12), 8, (f: GFile) => listSafe(token, f.id));
    const hits: GFile[] = [], next: GFile[] = [];
    for (const kids of lists) {
      for (const k of kids) {
        if (!isFolder(k)) continue;
        const kn = norm(k.name);
        if (kn === n || kn.includes(n) || (n.length >= 8 && kn.length >= 6 && n.includes(kn))) hits.push(k);
        else next.push(k);
      }
    }
    if (hits.length) return hits.slice(0, 2);
    level = next;
  }
  return [];
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
  const files: GFile[] = (data.files ?? []).filter((f: GFile) => !isFolder(f));
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
async function writeFile(token: string, folderId: string, name: string, content: string, mimeType = "text/plain", encoding = ""): Promise<string> {
  // Replace an existing file of the same name so re-writes don't duplicate.
  const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`);
  const existing = await drive(token, `files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const prevId = existing.files?.[0]?.id;

  const boundary = "ebodm" + Math.random().toString(36).slice(2);
  const metadata: Record<string, unknown> = prevId ? { name } : { name, parents: [folderId] };
  // encoding "base64" carries a real binary — a PDF, a spreadsheet, a photo.
  // Drive accepts it verbatim in a multipart part with this header.
  const b64 = encoding === "base64";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n${b64 ? "Content-Transfer-Encoding: base64\r\n" : ""}\r\n${content}\r\n--${boundary}--`;

  const url = prevId
    ? `https://www.googleapis.com/upload/drive/v3/files/${prevId}?uploadType=multipart&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;
  const res = await fetch(url, {
    method: prevId ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`drive write failed: ${await res.text()}`);
  const data = await res.json();
  return data.id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SA_EMAIL || !SA_KEY) return json({ error: "Google service-account secrets not set" }, 500);

  // Body is parsed regardless of content-type (the app sends text/plain so the
  // same call also works against the Apps Script backend without a preflight).
  let body: { projectId?: string; linkedIds?: string[]; token?: string; action?: string; fileName?: string; content?: string; mimeType?: string; encoding?: string; scope?: string; search?: string };
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "invalid JSON body" }, 400); }
  const expected = Deno.env.get("DRIVE_READ_TOKEN") ?? "";
  if (expected && body.token !== expected) return json({ error: "unauthorized" }, 401);
  const needles = [body.projectId, ...(body.linkedIds ?? [])].filter(Boolean) as string[];
  // No project named is a legitimate question ("find the checklists across the
  // ODM folder") as long as there is something to search for — it used to be a
  // flat 400.
  if (!needles.length && !String(body.search || "").trim() && body.action !== "write") {
    return json({ ok: true, digest: "", note: "no project or search term given" });
  }

  // Fresh listings and a fresh clock for every request.
  kidsCache = new Map();
  deadline = Date.now() + BUDGET_MS;

  try {
    const token = await getAccessToken();

    // ── write action: { action:"write", projectId, fileName, content } ──
    if (body.action === "write") {
      if (!body.fileName || body.content == null) return json({ error: "fileName and content required" }, 400);
      // Same address as the read side, so writes land in the real project folder.
      const br = await resolveBranches(token);
      let folders: GFile[] = [];
      for (const key of (body.scope === "pcb" ? ["pcb", "pm"] : ["pm", "pcb"])) {
        const root = br[key as "pm" | "pcb"];
        if (!root) continue;
        folders = await findFolderUnder(token, root, String(body.projectId));
        if (folders.length) break;
      }
      if (!folders.length) folders = await findFolders(token, String(body.projectId));
      if (!folders.length) return json({ error: `no Drive folder found for ${body.projectId}` }, 404);
      const id = await writeFile(token, folders[0].id, String(body.fileName), String(body.content), body.mimeType || "text/plain", body.encoding || "");
      return json({ ok: true, fileId: id, folder: folders[0].name });
    }

    // PMs look in Project Management first, engineers in PCB & Firmware —
    // but both branches are searched either way.
    const order = body.scope === "pcb" ? ["pcb", "pm"] : ["pm", "pcb"];
    const branches = await resolveBranches(token);
    const search = String(body.search || "").trim();

    const lines: string[] = [];
    // Every readable file we met, with its full path, so we can read the most
    // useful ones after the whole tree is mapped (not just the first folder's).
    const candidates: Entry[] = [];

    if (branches.ok) lines.push(`Everything below lives under ${ROOT_PATH}${order[0] === "pcb" ? BRANCH.pcb : BRANCH.pm}/.`);

    // No project named — search the whole chain for what they asked about.
    if (!needles.length) {
      const hits = await searchUnder(token, ROOT_CHAIN[0], search);
      if (!hits.length) {
        lines.push(`Nothing named like "${search}" turned up anywhere under ${ROOT_PATH}.`);
      } else {
        lines.push(`Searched the whole of ${ROOT_PATH} for "${search}" — ${hits.length} file(s) match by name:`);
        for (const f of hits) {
          const path = (f as GFile & { _path?: string })._path || "";
          lines.push(`  ${path || f.name} · modified ${String(f.modifiedTime || "").slice(0, 10)}`);
          candidates.push({ f, path: path.replace(new RegExp(`${f.name}/$`), "") });
        }
      }
    }

    for (const needle of needles.slice(0, 4)) {
      if (outOfTime()) { lines.push(`(stopped early — ${needle} and anything after it were not opened this time)`); break; }
      // 1. the proper address, 2. the other branch, 3. anywhere in Drive.
      let folders: GFile[] = [];
      let where = "";
      for (const key of order) {
        const root = branches[key as "pm" | "pcb"];
        if (!root) continue;
        folders = await findFolderUnder(token, root, needle);
        if (folders.length) { where = `${ROOT_PATH}${root.name}/`; break; }
      }
      if (!folders.length) { folders = await findFolders(token, needle); where = ""; }
      if (!folders.length) { lines.push(`Nothing found in Drive for ${needle} yet.`); continue; }

      for (const folder of folders.slice(0, 2)) {
        const base = where || await folderPath(token, folder).then((p) => p.replace(new RegExp(`${folder.name}/$`), ""));
        const path = `${base}${folder.name}/`;
        const { entries, truncated } = await walkTree(token, folder, path);
        const fileCount = entries.filter((e) => !isFolder(e.f)).length;
        lines.push(`FOLDER ${folder.name} — real Drive path: ${path} · ${fileCount} file(s) in ${entries.filter((e) => isFolder(e.f)).length + 1} folder(s), listed in full below${folder.webViewLink ? ` · link: ${folder.webViewLink}` : ""}`);
        if (truncated) lines.push(`  (very large folder — the listing below is the first ${entries.length} items)`);
        for (const e of entries) {
          lines.push(`  ${e.path}${e.f.name}${isFolder(e.f) ? "/" : ""} · ${isFolder(e.f) ? "folder" : (e.f.mimeType || "").split(".").pop()} · modified ${String(e.f.modifiedTime || "").slice(0, 10)}`);
          if (!isFolder(e.f)) candidates.push(e);
        }
      }
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
    const shortlist = candidates.slice(0, search ? 10 : 8);
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
    return json({ error: String(e) }, 500);
  }
});
