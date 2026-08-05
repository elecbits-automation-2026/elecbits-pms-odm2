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

async function findFolders(token: string, needle: string): Promise<GFile[]> {
  const q = encodeURIComponent(`name contains '${needle.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
  const data = await drive(token, `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,parents,webViewLink)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
  return data.files ?? [];
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

async function extractText(token: string, f: GFile): Promise<string> {
  try {
    if (f.mimeType === "application/vnd.google-apps.document") {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.text()).slice(0, 1200);
    } else if (f.mimeType === "application/vnd.google-apps.spreadsheet") {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/csv`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.text()).slice(0, 1200);
    } else if (/^text\/|json|csv/.test(f.mimeType) && Number(f.size || 0) < 200_000) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.text()).slice(0, 1200);
    }
  } catch { /* best effort */ }
  return "";
}

/* ── WRITE ─────────────────────────────────────────────────────────────────
   Create (or overwrite) a text/markdown file inside the project's Drive
   folder. Used to push closure evidence, status notes and AI analyses back to
   /ODM/PM/<ProjectID>/. Requires the folder shared as Editor.               */
async function writeFile(token: string, folderId: string, name: string, content: string, mimeType = "text/plain"): Promise<string> {
  // Replace an existing file of the same name so re-writes don't duplicate.
  const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`);
  const existing = await drive(token, `files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const prevId = existing.files?.[0]?.id;

  const boundary = "ebodm" + Math.random().toString(36).slice(2);
  const metadata: Record<string, unknown> = prevId ? { name } : { name, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;

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
  let body: { projectId?: string; linkedIds?: string[]; token?: string; action?: string; fileName?: string; content?: string; mimeType?: string };
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
      const id = await writeFile(token, folders[0].id, String(body.fileName), String(body.content), body.mimeType || "text/plain");
      return json({ ok: true, fileId: id, folder: folders[0].name });
    }

    const lines: string[] = [];
    let extracts = 0;
    for (const needle of needles.slice(0, 6)) {
      const folders = await findFolders(token, needle);
      if (!folders.length) { lines.push(`[${needle}] no matching Drive folder found`); continue; }
      for (const folder of folders.slice(0, 2)) {
        const files = await listChildren(token, folder.id);
        const path = await folderPath(token, folder);
        lines.push(`FOLDER ${folder.name} — real Drive path: ${path} (${files.length} items)${folder.webViewLink ? ` · link: ${folder.webViewLink}` : ""}`);
        for (const f of files.slice(0, 20)) {
          const kind = isFolder(f) ? "folder" : f.mimeType.split(".").pop();
          lines.push(`  - ${path}${f.name}${isFolder(f) ? "/" : ""} · ${kind} · modified ${String(f.modifiedTime || "").slice(0, 10)}`);
        }
        // one level deeper for sub-folders, so the AI sees the real structure
        for (const sub of files.filter(isFolder).slice(0, 5)) {
          try {
            const kids = await listChildren(token, sub.id);
            lines.push(`  SUBFOLDER ${path}${sub.name}/ (${kids.length} items):`);
            for (const k of kids.slice(0, 12)) {
              lines.push(`    - ${path}${sub.name}/${k.name}${isFolder(k) ? "/" : ""} · ${isFolder(k) ? "folder" : k.mimeType.split(".").pop()} · modified ${String(k.modifiedTime || "").slice(0, 10)}`);
            }
          } catch { /* keep going */ }
        }
        // extract text from up to 2 key files per folder (checklists, docs, notes)
        for (const f of files.filter((x) => /checklist|status|report|lld|notes?/i.test(x.name)).slice(0, 2)) {
          if (extracts >= 4) break;
          const txt = await extractText(token, f);
          if (txt) { lines.push(`  EXTRACT ${f.name}: """${txt}"""`); extracts++; }
        }
      }
    }
    return json({ ok: true, digest: lines.join("\n").slice(0, 6000) });
  } catch (e) {
    // Log it too, so the reason is visible in the function's Logs tab and not
    // only in the response body.
    console.error("drive-read failed:", String(e));
    return json({ error: String(e) }, 500);
  }
});
