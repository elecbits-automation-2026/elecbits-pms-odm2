/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Elecbits ODM — Drive reader (Google Apps Script)
 *
 * A drop-in alternative to the `drive-read` Supabase Edge Function for orgs
 * where service-account key creation is blocked by policy
 * (iam.disableServiceAccountKeyCreation). This script runs AS YOU, so it reads
 * whatever Drive you can already see — no service account, no GCP console, no
 * key file, no org-policy override.
 *
 * It answers with exactly the same shape the app expects: { ok, digest }.
 *
 * ── SETUP (5 minutes, no terminal) ─────────────────────────────────────────
 * 1. Go to https://script.google.com → New project. Name it "Elecbits Drive Reader".
 * 2. Delete the sample code, paste this whole file, and save.
 * 3. Edit SHARED_TOKEN below to any long random string of your choosing.
 * 4. Deploy → New deployment → type "Web app":
 *      Execute as:        Me (your@elecbits.in)
 *      Who has access:    Anyone
 *    → Deploy → Authorize access → allow the Drive permission.
 * 5. Copy the Web app URL (…/exec).
 * 6. In Vercel → Environment Variables add BOTH:
 *      VITE_DRIVE_READ_URL   = <the /exec URL>
 *      VITE_DRIVE_READ_TOKEN = <the same SHARED_TOKEN string>
 *    → Redeploy.
 *
 * "Who has access: Anyone" is required for the browser to call it, which is
 * why the SHARED_TOKEN matters — requests without the right token are refused.
 * Treat the token like a password; rotate it here and in Vercel to revoke.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ⚠️ CHANGE THIS to a long random string, and use the same value in Vercel.
var SHARED_TOKEN = "change-me-to-a-long-random-string";

// Files whose text is worth extracting into the digest.
var INTERESTING = /checklist|status|report|lld|note|bom|test/i;

function doPost(e) {
  var out = { ok: false, digest: "" };
  try {
    var body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { body = {}; }

    if (SHARED_TOKEN && body.token !== SHARED_TOKEN) {
      return json({ error: "unauthorized" });
    }

    var needles = [];
    if (body.projectId) needles.push(String(body.projectId));
    (body.linkedIds || []).forEach(function (x) { if (x) needles.push(String(x)); });
    if (!needles.length) return json({ error: "projectId required" });

    var lines = [];
    var extracts = 0;

    needles.slice(0, 6).forEach(function (needle) {
      var folders = findFolders(needle);
      if (!folders.length) {
        lines.push("[" + needle + "] no matching Drive folder found");
        return;
      }
      folders.slice(0, 2).forEach(function (folder) {
        var files = listFiles(folder);
        lines.push("FOLDER " + folder.getName() + " (" + files.length + " items):");
        files.slice(0, 20).forEach(function (f) {
          lines.push("  - " + f.name + " · " + shortType(f.mime) + " · modified " + f.modified);
        });
        files.forEach(function (f) {
          if (extracts >= 4) return;
          if (!INTERESTING.test(f.name)) return;
          var txt = extractText(f);
          if (txt) {
            lines.push('  EXTRACT ' + f.name + ': """' + txt + '"""');
            extracts++;
          }
        });
      });
    });

    out.ok = true;
    out.digest = lines.join("\n").slice(0, 6000);
    return json(out);
  } catch (err) {
    return json({ error: String(err) });
  }
}

/** Health check in a browser tab. */
function doGet() {
  return json({ ok: true, service: "elecbits-drive-read", hint: "POST { projectId, linkedIds, token }" });
}

function findFolders(needle) {
  var found = [];
  var it = DriveApp.searchFolders('title contains "' + needle.replace(/"/g, '\\"') + '" and trashed = false');
  while (it.hasNext() && found.length < 5) found.push(it.next());
  return found;
}

function listFiles(folder) {
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext() && out.length < 50) {
    var f = it.next();
    out.push({
      id: f.getId(),
      name: f.getName(),
      mime: f.getMimeType(),
      size: f.getSize ? f.getSize() : 0,
      modified: Utilities.formatDate(f.getLastUpdated(), "UTC", "yyyy-MM-dd"),
      file: f,
    });
  }
  // sub-folders listed as entries so the AI sees the structure
  var sub = folder.getFolders();
  while (sub.hasNext() && out.length < 60) {
    var d = sub.next();
    out.push({ id: d.getId(), name: d.getName() + "/", mime: "folder", size: 0, modified: Utilities.formatDate(d.getLastUpdated(), "UTC", "yyyy-MM-dd"), file: null });
  }
  out.sort(function (a, b) { return a.modified < b.modified ? 1 : -1; });
  return out;
}

function extractText(f) {
  try {
    if (!f.file) return "";
    if (f.mime === MimeType.GOOGLE_DOCS) {
      return DocumentApp.openById(f.id).getBody().getText().slice(0, 1200);
    }
    if (f.mime === MimeType.GOOGLE_SHEETS) {
      var sh = SpreadsheetApp.openById(f.id);
      var parts = [];
      sh.getSheets().slice(0, 3).forEach(function (s) {
        var rng = s.getDataRange().getValues().slice(0, 15);
        parts.push("[" + s.getName() + "] " + rng.map(function (r) { return r.join(" | "); }).join("\n"));
      });
      return parts.join("\n").slice(0, 1500);
    }
    if (/^text\/|json|csv/.test(f.mime) && f.size < 200000) {
      return f.file.getBlob().getDataAsString().slice(0, 1200);
    }
  } catch (err) { /* best effort */ }
  return "";
}

function shortType(mime) {
  if (!mime) return "file";
  if (mime === "folder") return "folder";
  var bits = String(mime).split(".");
  return bits[bits.length - 1];
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
