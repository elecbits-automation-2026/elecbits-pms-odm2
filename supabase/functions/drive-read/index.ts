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

async function listChildren(token: string, folderId: string): Promise<GFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const data = await drive(token, `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=50&orderBy=folder,modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return data.files ?? [];
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
  let body: { projectId?: string; linkedIds?: string[]; token?: string; action?: string; fileName?: string; content?: string; mimeType?: string; encoding?: string };
  try { body = JSON.parse(await req.text()); } catch { return json({ error: "invalid JSON body" }, 400); }
  const expected = Deno.env.get("DRIVE_READ_TOKEN") ?? "";
  if (expected && body.token !== expected) return json({ error: "unauthorized" }, 401);
  const needles = [body.projectId, ...(body.linkedIds ?? [])].filter(Boolean) as string[];
  if (!needles.length) return json({ error: "projectId required" }, 400);

  try {
    const token = await getAccessToken();

    // ── write action: { action:"write", projectId, fileName, content } ──
    if (body.action === "write") {
      if (!body.fileName || body.content == null) return json({ error: "fileName and content required" }, 400);
      const folders = await findFolders(token, String(body.projectId));
      if (!folders.length) return json({ error: `no Drive folder found for ${body.projectId}` }, 404);
      const id = await writeFile(token, folders[0].id, String(body.fileName), String(body.content), body.mimeType || "text/plain", body.encoding || "");
      return json({ ok: true, fileId: id, folder: folders[0].name });
    }

    const lines: string[] = [];
    // Every readable file we met, with its full path, so we can read the most
    // useful ones after the whole tree is mapped (not just the first folder's).
    const candidates: { f: GFile; path: string }[] = [];

    for (const needle of needles.slice(0, 6)) {
      const folders = await findFolders(token, needle);
      if (!folders.length) { lines.push(`Nothing found in Drive for ${needle} yet.`); continue; }
      for (const folder of folders.slice(0, 2)) {
        const files = await listChildren(token, folder.id);
        const path = await folderPath(token, folder);
        lines.push(`FOLDER ${folder.name} — real Drive path: ${path} (${files.length} items)${folder.webViewLink ? ` · link: ${folder.webViewLink}` : ""}`);
        for (const f of files.slice(0, 20)) {
          const kind = isFolder(f) ? "folder" : f.mimeType.split(".").pop();
          lines.push(`  - ${path}${f.name}${isFolder(f) ? "/" : ""} · ${kind} · modified ${String(f.modifiedTime || "").slice(0, 10)}`);
          if (!isFolder(f)) candidates.push({ f, path });
        }
        // one level deeper for sub-folders, so the AI sees the real structure
        for (const sub of files.filter(isFolder).slice(0, 5)) {
          try {
            const kids = await listChildren(token, sub.id);
            lines.push(`  SUBFOLDER ${path}${sub.name}/ (${kids.length} items):`);
            for (const k of kids.slice(0, 12)) {
              lines.push(`    - ${path}${sub.name}/${k.name}${isFolder(k) ? "/" : ""} · ${isFolder(k) ? "folder" : k.mimeType.split(".").pop()} · modified ${String(k.modifiedTime || "").slice(0, 10)}`);
              if (!isFolder(k)) candidates.push({ f: k, path: `${path}${sub.name}/` });
            }
          } catch { /* keep going */ }
        }
      }
    }

    // Read what is INSIDE the files, not just their names. Interesting ones
    // first (checklists, reports, LLDs, BoMs…), then whatever is most recent.
    const score = (n: string) => (/checklist|status|report|lld|note|bom|spec|minutes|plan|test/i.test(n) ? 0 : 1);
    candidates.sort((a, b) =>
      score(a.f.name) - score(b.f.name) ||
      String(b.f.modifiedTime || "").localeCompare(String(a.f.modifiedTime || "")));

    let extracts = 0, tries = 0;
    for (const { f, path } of candidates) {
      if (extracts >= 8 || tries >= 14) break;   // keep well inside the function timeout
      tries++;
      const txt = await extractText(token, f);
      if (txt) { lines.push(`  CONTENTS OF ${path}${f.name}: """${txt}"""`); extracts++; }
    }

    return json({ ok: true, digest: lines.join("\n").slice(0, 18000) });
  } catch (e) {
    // Log it too, so the reason is visible in the function's Logs tab and not
    // only in the response body.
    console.error("drive-read failed:", String(e));
    return json({ error: String(e) }, 500);
  }
});
