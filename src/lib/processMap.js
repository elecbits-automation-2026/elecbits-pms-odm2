/* ─── THE PROCESS MAP ──────────────────────────────────────────────────────
   The company's method, as data: 305 steps, what opens and closes each one,
   the question that must be answerable before it starts, the template it
   writes to, and where that file belongs in Drive.

   Everything a project plan needs comes from here. A project is the process
   map with its [ProjectID] filled in, its steps dated against the milestones,
   and each step handed to whoever holds the matching slot on that project.

   Regenerated from the master workbook by scripts/build-process-map.mjs.
   Nothing in the app reads the spreadsheet — this JSON is the source.        */

import BUNDLED from "../data/process-map.json";

/* ── WHERE THE METHOD COMES FROM ─────────────────────────────────────────────
   The workbook lives in Drive and is edited there. This module follows it: it
   reads the live file, and the copy compiled into the build is a fallback for
   when Drive cannot be reached — never a quiet substitute.

   That distinction is the whole point. A plan built from last month's method
   looks exactly like a plan built from this morning's, so the source and the
   date are carried alongside the data and shown, rather than left to trust. */
let MAP = BUNDLED;

export const SOURCE = {
  from: "bundled",          // drive | cache | bundled
  fileName: "",
  path: "",
  editLink: "",
  modifiedTime: "",
  fetchedAt: "",
  error: "",
};

export const PROCESS = () => MAP;
export let STEPS = MAP.steps;
export let CATEGORIES = MAP.categories;
export let TEMPLATES = MAP.templates;

/* ── the major blocks, and their sequence ────────────────────────────────────
   The Flow Map tab is the only document that names the blocks and fixes the
   order they run in: A runs alone, B splits into three concurrent design
   tracks with test inline and the DFx gates across them, C runs serially after
   the merge. Ten blocks, 308 steps, and every step belongs to exactly one.

   A plan read as 308 numbered rows is unreadable. Read as ten named blocks in
   sequence it is the same plan somebody can hold in their head.              */
export let BLOCKS = MAP.blocks || [];

/* The points where the parallel tracks must stop and agree with each other.
   Without these the schedule will happily let hardware finish a layout against
   an enclosure revision nobody signed off. */
export let CONVERGENCE = MAP.convergence || [];

/* The wave graph comes from the flow diagram, which is a drawing and cannot be
   parsed at runtime — so it stays compiled in, keyed by step NAME. A workbook
   edited in Drive has rows inserted, moved and deleted, and a row number would
   silently point at the wrong step the moment that happened; a name survives
   it. Anything genuinely new gets no wave and is reported rather than being
   given a neighbour's dependencies. */
function applyWaves(map) {
  const byName = BUNDLED.waveByName || {};
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // Category AND name: "System Block Diagram" starts both the hardware and the
  // firmware track, and a name-only key folds them into one wave.
  const key = (s) => `${norm(s.category)}|${norm(s.step)}`;
  const waves = (BUNDLED.waves || []).map((w) => ({ ...w, steps: [] }));
  const index = new Map(waves.map((w) => [w.id, w]));
  const unplaced = [];
  for (const s of map.steps) {
    const id = byName[key(s)] || "";
    s.wave = id;
    if (index.has(id)) index.get(id).steps.push(s.no);
    else unplaced.push(s);
  }
  /* A step the diagram never drew — a new one, or a renamed one — joins the
     wave of its nearest neighbour by number, which is what "inline" means for
     the test and audit steps that were always in this position. */
  const placed = map.steps.filter((s) => index.has(s.wave));
  for (const s of unplaced) {
    if (!placed.length) break;
    const near = placed.reduce((best, x) => Math.abs(x.no - s.no) < Math.abs(best.no - s.no) ? x : best, placed[0]);
    s.wave = near.wave;
    index.get(near.wave).steps.push(s.no);
  }
  map.waves = waves.filter((w) => w.steps.length);
  map.newSteps = unplaced.map((s) => s.step);
  return map;
}

/* Categories, derived rather than stored — the workbook is the only place the
   list lives, and a category added in Drive has to appear here without a code
   change. Which ones run concurrently comes from the Flow Map tab. */
function deriveCategories(map) {
  const cats = [];
  for (const s of map.steps) {
    let c = cats.find((x) => x.name === s.category);
    if (!c) {
      const phase = Number((s.category.match(/^(\d+)/) || [])[1]) || 99;
      c = { name: s.category, phase, count: 0, first: s.no, last: s.no };
      cats.push(c);
    }
    c.count++; c.first = Math.min(c.first, s.no); c.last = Math.max(c.last, s.no);
  }
  cats.sort((a, b) => a.phase - b.phase || a.first - b.first);
  for (const c of cats) {
    const b = (map.blocks || []).find((x) => x.category === c.name);
    c.parallel = /concurrent/i.test(b?.runs || "");
    c.gated = /gated/i.test(b?.runs || "");
    c.runs = b?.runs || "";
  }
  map.categories = cats;
  return map;
}

/* Which block each step is in, and which steps are convergence points. Done
   here rather than trusted from the file because the workbook is edited in
   Drive between builds: a step added there arrives with no block, and a step
   with no block falls out of every view that reads the plan by block.

   A category split across two blocks (Test is drawn inline per track AND again
   after the merge) is divided by the Flow Map's own counts, in the order the
   Flow Map lists the blocks — so the split comes from the document rather than
   from a rule invented here. */
function deriveBlocks(map) {
  const blocks = map.blocks || [];
  const byCategory = {};
  for (const b of blocks) (byCategory[b.category] ||= []).push(b);
  const at = new Map();
  for (const [cat, bs] of Object.entries(byCategory)) {
    const inCat = map.steps.filter((s) => s.category === cat).sort((a, b) => a.no - b.no);
    if (bs.length === 1) { for (const s of inCat) at.set(s.no, bs[0].id); continue; }
    let cursor = 0;
    for (const b of bs) {
      for (const s of inCat.slice(cursor, cursor + b.steps)) at.set(s.no, b.id);
      cursor += b.steps;
    }
    for (const s of inCat.slice(cursor)) at.set(s.no, bs[bs.length - 1].id);
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const conv = new Map();
  for (const cv of map.convergence || []) {
    for (const no of cv.steps || []) conv.set(no, cv);
    // Resolved by name too: a step renumbered in Drive keeps its name.
    for (const s of map.steps) if (norm(s.step) === norm(cv.name)) conv.set(s.no, cv);
  }
  for (const s of map.steps) {
    s.block = at.get(s.no) || s.block || "";
    const cv = conv.get(s.no);
    if (cv) s.converge = { n: cv.n, name: cv.name, tracks: cv.tracks, agree: cv.agree, merge: !!cv.merge };
  }
  return map;
}

function adopt(map) {
  MAP = applyWaves(deriveBlocks(deriveCategories(map)));
  STEPS = MAP.steps;
  CATEGORIES = MAP.categories;
  TEMPLATES = MAP.templates;
  BLOCKS = MAP.blocks || [];
  CONVERGENCE = MAP.convergence || [];
  WAVES = MAP.waves || [];
  // Views memoise plans built from STEPS and BLOCKS; without a signal they
  // would keep showing the old method after a new one was adopted.
  try { window.dispatchEvent(new Event("eb-process-map")); } catch { /* not a browser */ }
  return MAP;
}

/* The blocks, grouped the way the Flow Map draws them: A, then B with its
   concurrent tracks side by side, then C. */
export function blocksInSequence(blocks = BLOCKS) {
  const groups = [];
  for (const b of blocks) {
    let g = groups.find((x) => x.group === b.group);
    if (!g) { g = { group: b.group, blocks: [], steps: 0, concurrent: false }; groups.push(g); }
    g.blocks.push(b);
    g.steps += b.steps;
    if (/concurrent/i.test(b.runs)) g.concurrent = true;
  }
  return groups;
}

export const blockById = (id) => BLOCKS.find((b) => b.id === id) || null;
export const blockOf = (step) => blockById(step?.block);
export const stepsInBlock = (id) => STEPS.filter((s) => s.block === id);

/* The convergence points that touch a step, for the work window: "this review
   cannot be closed until Firmware and Enclosure have agreed the pin map." */
export const convergenceAt = (step) =>
  CONVERGENCE.find((cv) => (cv.steps || []).includes(step?.no)) ||
  (step?.converge ? CONVERGENCE.find((cv) => cv.n === step.converge.n) || step.converge : null);

/* ── loading it from Drive ───────────────────────────────────────────────────
   Once per session, or on demand when somebody has just edited the workbook.
   The cache is what makes an offline Drive survivable without pretending: the
   data is used, and SOURCE says it is a cached copy and how old it is.       */
const CACHE_KEY = "eb-process-map-v1";

/* ── pinning the workbook ────────────────────────────────────────────────────
   Finding the master workbook by name is a guess that usually lands — but a
   guess. A pasted Drive link removes the guess: the file id inside it names
   the exact file, however it is renamed or moved, and the search never runs.
   The process itself rarely changes; WHERE it lives does. */
const PIN_KEY = "eb-process-pin-v1";
export const PIN = { fileId: "", url: "" };
try {
  const saved = JSON.parse(localStorage.getItem(PIN_KEY) || "null");
  if (saved?.fileId) Object.assign(PIN, saved);
} catch { /* no localStorage here */ }

/* Every shape a Drive link comes in — /file/d/<id>/, /spreadsheets/d/<id>/,
   ?id=<id> — carries the same 25+ character id. */
export function pinWorkbook(url) {
  const m = /[-\w]{25,}/.exec(String(url || ""));
  if (!m) return { error: "That doesn't look like a Drive link — it should contain the long file id." };
  Object.assign(PIN, { fileId: m[0], url: String(url).trim() });
  try { localStorage.setItem(PIN_KEY, JSON.stringify(PIN)); } catch { /* session-only then */ }
  return { ok: true, fileId: PIN.fileId };
}
export function clearPin() {
  Object.assign(PIN, { fileId: "", url: "" });
  try { localStorage.removeItem(PIN_KEY); } catch { /* fine */ }
}

function fromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c?.map?.steps?.length ? c : null;
  } catch { return null; }
}

/* The uploaded workbook keeps its OWN slot. CACHE_KEY is one slot and a Drive
   sync overwrites it — which is exactly how a link-less sync once erased the
   uploaded copy from the browser entirely. The upload slot is written only by
   an upload and read whenever the synced copy would be a downgrade. */
const UPLOAD_KEY = "eb-process-upload-v1";
function fromUploadSlot() {
  try {
    const raw = localStorage.getItem(UPLOAD_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c?.map?.steps?.length ? c : null;
  } catch { return null; }
}
const linkedCount = (ss) => (ss || []).filter((s) => s?.openLink || Object.keys(s?.openLinks || {}).length).length;

/* An uploaded workbook is the method EVERYWHERE, not only on the page that
   happens to call loadProcessMap. Rehydrate it the moment this module loads,
   so a work window opened straight from My Projects & Tasks after a reload
   carries the upload's per-step links instead of the bundled fallback. */
try {
  const boot = fromUploadSlot() || (fromCache()?.source?.from === "upload" ? fromCache() : null);
  if (boot?.map) {
    adopt(boot.map);
    Object.assign(SOURCE, boot.source, { from: "upload" });
  }
} catch { /* no cache, no browser — the bundled method stands */ }

export async function loadProcessMap(readDrive, { force = false } = {}) {
  /* An uploaded workbook was handed over deliberately — including a project
     copy whose per-step links a by-name Drive search could never reproduce.
     A background refresh must not quietly replace it; only an explicit act
     (pinning, or the refresh the user forces) may. */
  if (!force && (SOURCE.from === "drive" || SOURCE.from === "upload")) return MAP;

  // A cached copy first, so the app is usable in the second before Drive
  // answers — then replaced the moment the live one arrives.
  const cached = fromCache();
  if (cached && SOURCE.from === "bundled") {
    adopt(cached.map);
    const wasUpload = cached.source?.from === "upload";
    Object.assign(SOURCE, cached.source, wasUpload ? {} : { from: "cache" });
    if (wasUpload && !force) return MAP;
  }

  if (typeof readDrive !== "function") return MAP;
  const wasFrom = SOURCE.from;
  try {
    const r = await readDrive({ action: "process_map", ...(PIN.fileId ? { fileId: PIN.fileId } : {}) });
    if (r?.error) throw new Error(r.error);
    if (!r?.steps?.length) throw new Error("Drive returned a workbook with no steps in it.");

    /* The per-step links ARE the workbook's payload. A Drive read that comes
       back without any (an old reader that only saw values) must never
       replace an uploaded copy that has them — that trade would quietly
       disconnect every task and plan row from its file. */
    if (linkedCount(r.steps) === 0) {
      if (wasFrom === "upload" && linkedCount(STEPS) > 0) {
        SOURCE.error = "Drive's copy came back without the per-step links — keeping the uploaded workbook (re-deploy the Drive reader, then sync again).";
        return MAP;
      }
      // Whatever is in memory, a saved upload with links beats a link-less
      // sync — restore it rather than adopting the downgrade.
      const slot = fromUploadSlot();
      if (slot && linkedCount(slot.map.steps) > 0) {
        adopt(slot.map);
        Object.assign(SOURCE, slot.source, { from: "upload",
          error: "Drive's copy has no per-step links — using the uploaded workbook instead (re-deploy the Drive reader, then sync again)." });
        return MAP;
      }
    }

    adopt({ steps: r.steps, templates: r.templates || {},
             // A workbook without a Flow Map (or a server that read none) must
             // not dissolve the block structure the whole plan is read by.
             blocks: r.blocks?.length ? r.blocks : BUNDLED.blocks || [],
             convergence: r.convergence?.length ? r.convergence : BUNDLED.convergence || [],
             // The server does not read the Project tab; the boards and folder
             // links the upload established describe the same workbook.
             projectCopy: MAP.projectCopy || null });
    Object.assign(SOURCE, {
      from: "drive", error: "",
      fileName: r.file?.name || "", path: r.file?.path || "",
      editLink: r.file?.editLink || "", modifiedTime: r.file?.modifiedTime || "",
      fetchedAt: new Date().toISOString(),
      alternates: r.alternates || [],
    });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        map: { steps: r.steps, templates: r.templates || {},
               blocks: r.blocks?.length ? r.blocks : BUNDLED.blocks || [],
               convergence: r.convergence?.length ? r.convergence : BUNDLED.convergence || [] },
        source: { ...SOURCE },
      }));
    } catch { /* a full quota is not a reason to fail the load */ }
  } catch (e) {
    // Say which copy is being used and why the live one is not — never fall
    // back silently, because a stale plan is indistinguishable from a current
    // one until somebody works to the wrong method.
    SOURCE.error = String(e?.message || e);
    // A failed refresh does not change WHICH copy is in memory: an uploaded
    // workbook stays "upload" (with the error beside it), it does not get
    // relabelled as the bundled fallback it never was.
    if (wasFrom === "upload") SOURCE.from = "upload";
    else if (SOURCE.from !== "cache") SOURCE.from = "bundled";
  }
  return MAP;
}

/* ── an uploaded workbook ────────────────────────────────────────────────────
   The same file, handed over directly instead of found in Drive — for the day
   Drive is slow, the pin is stale, or somebody has the improved copy on their
   desk before it is uploaded. Parsed in the browser with exactly the reading
   the Drive path uses: steps from Process Flow, templates from Template
   Actions, blocks and convergence from a Flow Map read whole by its own
   section headers.

   What the workbook cannot know is filled from the bundled register: folders
   for the templates it never declares, the tree each one belongs to, what
   good looks like. An upload should improve the method, not amputate it.    */
export async function loadProcessMapFromUpload(file) {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  /* blankrows matters: sheet_to_json silently DROPS fully-empty rows, which
     shifts every later row index off the sheet's real rows — and hyperlinks
     are addressed by the sheet's real rows. With blank rows kept and the
     range's own origin subtracted, JSON coordinates and cell coordinates are
     the same thing again. */
  const sheetRows = (name) => wb.Sheets[name]
    ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", blankrows: true }) : null;
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

  /* Hyperlinks live on cells, not in values — and they are the whole point of
     the project copy: an Open link per step that goes to THIS project's own
     file. Keyed in JSON-row space so callers never think about the offset. */
  const linksOf = (name) => {
    const sh = wb.Sheets[name] || {};
    let origin = { r: 0, c: 0 };
    try { origin = XLSX.utils.decode_range(sh["!ref"]).s; } catch { /* empty sheet */ }
    const at = new Map();
    for (const addr in sh) {
      if (addr[0] === "!") continue;
      /* Two ways a link is written: a real cell hyperlink, or an =HYPERLINK()
         FORMULA — which is how the v11 instantiation scripts write column K.
         The formula's first argument is the link. */
      const t = sh[addr]?.l?.Target
        || (String(sh[addr]?.f || "").match(/HYPERLINK\s*\(\s*"([^"]+)"/i) || [])[1];
      if (t) { const c = XLSX.utils.decode_cell(addr); at.set(`${c.r - origin.r}:${c.c - origin.c}`, t); }
    }
    return (r, c) => (c >= 0 ? at.get(`${r}:${c}`) || "" : "");
  };

  const flow = sheetRows("Process Flow");
  if (!flow) return { error: `${file.name} has no "Process Flow" tab — is this the master workbook or a project copy of it?` };

  /* Columns are found by their HEADER, not their position. The master and the
     per-project copies lay the same information out differently, and the
     sheet was designed so the app never has to be taught a layout twice —
     which only holds if the app reads the words, not the column letters. */
  const headerRow = flow.findIndex((r) => /^s\.?\s?no\.?$/i.test(clean(r[0])));
  if (headerRow < 0) return { error: `${file.name}: no header row starting with "S. No." on the Process Flow tab.` };
  const H = flow[headerRow].map((h) => clean(h).toLowerCase());
  const col = (...res) => H.findIndex((h) => res.some((re) => re.test(h)));
  const C = {
    no: 0,
    category: col(/^category/),
    step: col(/^steps?$/),
    entryTrigger: col(/^entry trigger/), exitTrigger: col(/^exit trigger/),
    entryQuestion: col(/^entry question/), exitQuestion: col(/^exit question/),
    templateFile: col(/template link|file name/),
    templateId: col(/^template id/),
    template: col(/^template to work|^template$/),
    open: col(/^open\b/),
    // the 2-PCB project copy: which board a row belongs to, and whether the
    // step runs per board or once for the project
    pcb: col(/^pcb$/),
    scope: col(/^scope$/),
    // the v11 instance layout: one row per board/run, the Board column naming
    // which, and the Split Rule column declaring how the step instances
    board: col(/^board$/),
    splitRule: col(/^split rule/),
    // EVERY per-board link column, not just the first: one project workbook
    // carries one "Open — <board>" column per PCB, and each is a source.
    opens: H.map((h, i) => (/^open\b/.test(h) ? i : -1)).filter((i) => i >= 0),
    master: col(/^master/),
    location: col(/^location/),
    action: col(/^action/),
    whatToDo: col(/^what to do/),
    owner: col(/^owner/),
    responsibility: col(/^responsibility/),
    guidelines: col(/^guidelines/),
  };
  for (const need of ["category", "step", "responsibility"]) {
    if (C[need] < 0) return { error: `${file.name}: the Process Flow tab has no "${need}" column — the header row reads: ${H.filter(Boolean).join(" | ")}` };
  }

  const flowLink = linksOf("Process Flow");
  /* v11's Split Rule column, translated into the app's scope words. Board
     steps run per board; Board-Main runs once, on the MAIN board; the Mfg-*
     scopes belong to the manufacturing project, not the design one. */
  const SPLIT_SCOPES = {
    "project": "project", "board": "board", "board-main": "board-main",
    "mfg-project": "mfg-project", "mfg-run": "mfg-run",
    "mfg-runxboard": "mfg-run-board", "mfg-run-build": "mfg-run-build",
  };
  const steps = [];
  const byNo = new Map();
  for (let i = headerRow + 1; i < flow.length; i++) {
    const r = flow[i];
    /* "118" is a step. "118.a"/"118.b" are its per-board copies, and the v11
       instance adds "373/50" and "373/50.a" — the same step run per quantity
       run (and per board within a run). All copies fold back into the ONE
       step their base number names; the app re-expands per project itself. */
    const noMatch = /^(\d+)(?:[./][a-z0-9-]+)*$/i.exec(clean(r[C.no]));
    if (!noMatch || !clean(r[C.step])) continue;
    const no = Number(noMatch[1]);
    const cell = (k) => (C[k] >= 0 ? clean(r[C[k]]) : "");
    /* The v11 Board column names each row's instance — a dated board folder
       ("…-GW-119-040926  (main)"), a run ("1844-50"), or "—" for project
       rows. The board KEY keeps the board name and drops the decoration. */
    const boardCol = C.board >= 0
      ? clean(r[C.board]).replace(/\s*\((main|daughter)\)\s*$/i, "").replace(/^[—–-]$/, "")
      : "";
    const pcbRaw = cell("pcb") || boardCol;
    const boardKey = pcbRaw && !/^both$/i.test(pcbRaw) ? pcbRaw : "";
    const perRowBoards = C.pcb >= 0 || C.board >= 0;
    let st = byNo.get(no);
    if (!st) {
      st = {
        no, category: cell("category"), step: cell("step"),
        entryTrigger: cell("entryTrigger"), exitTrigger: cell("exitTrigger"),
        entryQuestion: cell("entryQuestion"), exitQuestion: cell("exitQuestion"),
        templateFile: cell("templateFile").replace(/^EB-T-\d+\s*[·|:-]\s*/, ""),
        templateId: cell("templateId"), template: cell("template"),
        action: cell("action"), whatToDo: cell("whatToDo"),
        owner: cell("owner"), responsibility: cell("responsibility"), guidelines: cell("guidelines"),
        // A declared scope ("Board" / "Project") outranks every inferred
        // rule — and v11 declares it as the Split Rule.
        scope: cell("scope").toLowerCase()
          || SPLIT_SCOPES[cell("splitRule").toLowerCase().replace(/×/g, "x").replace(/\s+/g, "")]
          || "",
        openLink: "", openLinks: {}, masterLink: "", location: "", locations: {},
      };
      /* the older layouts: one row per step, per-board links as extra
         "Open — <board>" COLUMNS keyed by their own label. A per-row layout
         (a PCB column exists) owns its links row by row instead. */
      for (const c of (perRowBoards ? [] : C.opens)) {
        const label = clean(flow[headerRow][c]).replace(/^open\s*[—–-]?\s*/i, "").replace(/^this project$/i, "");
        const url = flowLink(i, c);
        if (url) st.openLinks[label] = url;
      }
      byNo.set(no, st);
      steps.push(st);
    }
    /* every row contributes ITS board's link and location — but only the
       per-row layout writes keyed links here; in the one-row layouts the
       keyed links come from the labelled columns above, and a stray ""-key
       would hand an unknown board the first board's link. */
    const url = flowLink(i, C.open);
    if (url) {
      if (perRowBoards) st.openLinks[boardKey] = st.openLinks[boardKey] || url;
      st.openLink = st.openLink || url;
    }
    const master = flowLink(i, C.master);
    if (master) st.masterLink = st.masterLink || master;
    const loc = cell("location");
    if (loc) { if (boardKey) st.locations[boardKey] = st.locations[boardKey] || loc; st.location = st.location || loc; }
  }
  if (!steps.length) return { error: `${file.name} opened, but its Process Flow tab has no step rows.` };

  const templates = {};
  {
    const ta = sheetRows("Template Actions") || [];
    const taLink = linksOf("Template Actions");
    const th = ta.findIndex((r) => /^template id/i.test(clean(r[0])));
    for (let i = (th < 0 ? 4 : th + 1); i < ta.length; i++) {
      const r = ta[i];
      const id = clean(r[0]);
      if (!/^EB-T-/.test(id)) continue;
      /* The project copy writes "folder/EB-T-141_….docx" in one cell — the
         folder AND the file as it is actually saved. Split them: walking a
         .docx as if it were a folder is how every read used to die, and the
         real saved name is worth more than the idealized one. */
      const rawLoc = clean(r[3]);
      const isFile = /\.[a-z0-9]{2,5}$/i.test(rawLoc);
      templates[id] = {
        id, name: clean(r[1]),
        folder: isFile ? rawLoc.replace(/[^/]*$/, "") : rawLoc,
        fileNameReal: isFile ? rawLoc.split("/").pop() : "",
        steps: clean(r[4]).split(",").map((x) => Number(x.trim())).filter(Number.isFinite),
        actions: clean(r[6]).split("·").map((x) => x.trim()).filter(Boolean),
        link: taLink(i, 2) || "",
      };
    }
  }
  for (const [id, base] of Object.entries(BUNDLED.templates || {})) {
    const t = templates[id];
    if (!t) { templates[id] = { ...base }; continue; }
    templates[id] = { ...base, ...t, folder: t.folder || base.folder };
  }

  const blocks = [], convergence = [];
  {
    const fm = sheetRows("Flow Map") || [];
    let section = "";
    for (let i = 0; i < fm.length; i++) {
      const c = (fm[i] || []).map(clean);
      if (!c.some(Boolean)) continue;
      if (c[0] === "Block" && /categor/i.test(c[1] || "")) { section = "blocks"; continue; }
      if (/convergence step/i.test(c[1] || "")) { section = "convergence"; continue; }
      if (/^cross-track convergence/i.test(c[0] || "")) { section = ""; continue; }
      if (section === "blocks") {
        if (/^TOTAL$/i.test(c[0]) || /^TOTAL$/i.test(c[2])) { section = ""; continue; }
        if (!c[0] || !c[1]) continue;
        const group = (c[0].match(/^([A-Z])\b/) || [])[1] || "X";
        const nth = blocks.filter((b) => b.group === group).length + 1;
        const name = (c[1].replace(/^\d+\s*·\s*/, "") || c[1]).trim();
        blocks.push({ seq: blocks.length + 1, id: `${group}${nth}`, group,
          kind: c[0].replace(/^[A-Z]\s*[—–-]\s*/, "").trim() || "Serial",
          name, label: `${group}${nth} · ${name}`, block: c[0], category: c[1],
          sourceRows: c[2] || "", steps: Number(c[3]) || 0, runs: c[4] || "", convergesWith: c[5] || "" });
      } else if (section === "convergence") {
        if (!c[1]) continue;
        convergence.push({ n: Number(c[0]) || convergence.length + 1,
          name: c[1].replace(/\s*\(row\s*\d+\)\s*$/i, "").trim(),
          tracks: c[2] || "", agree: c[3] || "", merge: /merge/i.test(c[2] || ""), steps: [] });
      }
    }
    const known = new Set(steps.map((x) => x.category));
    for (const b of blocks) {
      if (known.has(b.category)) continue;
      const stem = b.category.replace(/\s*\([^)]*\)\s*$/, "");
      if (known.has(stem)) b.category = stem;
    }
  }

  /* The Project tab names whose copy this is — its per-step links belong to
     that project and no other. */
  let projectCopy = null;
  {
    const pr = sheetRows("Project") || [];
    const prLink = linksOf("Project");
    const find = (label) => {
      const i = pr.findIndex((r) => new RegExp(`^${label}$`, "i").test(clean(r[0])));
      return i < 0 ? ["", ""] : [clean(pr[i][1]), prLink(i, 1)];
    };
    const [projectId] = find("Project ID");
    const pcbIds = pr
      .filter((r) => /^pcb ids?$/i.test(clean(r[0])))
      .flatMap((r) => clean(r[1]).split(/[,;·]/))
      .map((x) => x.trim()).filter(Boolean);
    const pcbId = pcbIds[0] || "";
    // "PCB folder — GW-123" rows: one Drive folder per board
    const pcbFolders = {};
    pr.forEach((r, i) => {
      const m = /^pcb folder\s*[—–-]\s*(.+)$/i.exec(clean(r[0]));
      if (m) pcbFolders[m[1].trim()] = prLink(i, 1) || clean(r[1]);
    });
    const [pmText, pmLink] = find("Project folder");
    const [pcbText, pcbLink] = find("PCB folder");
    if (projectId) projectCopy = { projectId, pcbId, pcbIds, pcbFolders,
      pmFolderLink: pmLink || pmText, pcbFolderLink: pcbLink || pcbText };
  }
  /* The v11 instance carries no Project tab, but its FILE NAME is the project
     id — "Eb21EL287011809040926_MasterProcessFlow_v11.xlsx". That identity is
     what gates the per-step links to the right project, so it must not be
     lost just because the tab is. */
  if (!projectCopy) {
    const stem = String(file.name || "").split("_")[0].trim();
    if (/^eb\d/i.test(stem.replace(/[^a-z0-9]/gi, "")))
      projectCopy = { projectId: stem, pcbId: "", pcbIds: [], pcbFolders: {}, pmFolderLink: "", pcbFolderLink: "" };
  }

  /* The v11 instance writes its Flow Map as prose, so no block table arrives
     with it — and its category list outgrew the bundled blocks (commercial
     cycles, design release, ECN, incoming, the BB blocks). A category no
     block claims would fall out of every by-block view, so the gap is
     synthesized: bundled blocks keep the categories they know, and every
     category left over becomes a block of its own, in phase order. */
  const baseBlocks = blocks.length ? blocks : (BUNDLED.blocks || []);
  const claimed = new Set(baseBlocks.map((b) => b.category));
  const catOrder = [...new Set(steps.map((s) => s.category).filter(Boolean))]
    .map((name) => ({
      name,
      phase: Number((name.match(/^(\d+)/) || [])[1]) || 99,
      first: Math.min(...steps.filter((s) => s.category === name).map((s) => s.no)),
    }))
    .sort((a, b) => a.phase - b.phase || a.first - b.first);
  const mergedBlocks = [];
  let synthN = 0;
  for (const c of catOrder) {
    if (claimed.has(c.name)) { mergedBlocks.push(...baseBlocks.filter((b) => b.category === c.name)); continue; }
    synthN++;
    const short = c.name.replace(/^\d+\s*·\s*/, "").trim();
    mergedBlocks.push({
      seq: 0, id: `N${synthN}`, group: "N", kind: "Serial", name: short,
      label: `N${synthN} · ${short}`, block: "", category: c.name, sourceRows: "",
      steps: steps.filter((s) => s.category === c.name).length, runs: "",
    });
  }
  mergedBlocks.forEach((b, i) => { b.seq = i + 1; });

  adopt({ steps, templates,
    blocks: mergedBlocks.length ? mergedBlocks : (BUNDLED.blocks || []),
    convergence: convergence.length ? convergence : (BUNDLED.convergence || []),
    projectCopy });
  Object.assign(SOURCE, {
    from: "upload", error: "", fileName: file.name, path: "", editLink: "",
    modifiedTime: "", fetchedAt: new Date().toISOString(),
  });
  try {
    const payload = JSON.stringify({
      map: { steps, templates, blocks: MAP.blocks, convergence: MAP.convergence, projectCopy },
      source: { ...SOURCE },
    });
    localStorage.setItem(CACHE_KEY, payload);
    // The upload's own slot — the one a Drive sync can never overwrite.
    localStorage.setItem(UPLOAD_KEY, payload);
  } catch { /* quota */ }
  const linked = steps.filter((x) => x.openLink).length;
  return { ok: true, steps: steps.length, blocks: MAP.blocks.length, linked,
           projectCopy: projectCopy?.projectId || "" };
}

/* Whose copy the loaded workbook is, if it is one. */
export const projectCopyOf = () => MAP.projectCopy || null;

/* The workbook's Project tab links the actual Drive folders — the project's
   and each board's. When those links exist they beat any walk by name: Drive
   folder names drift ("Developers" holding one oddly-named folder is enough
   to strand a search), a folder ID cannot. Returns the ID to anchor reads and
   writes on, or "" when the workbook is silent or belongs to another project. */
export function driveRootFor(projectId, tree, board = "") {
  const c = MAP.projectCopy;
  if (!c) return "";
  if (projectId && c.projectId && !(normB(c.projectId).includes(normB(projectId)) || normB(projectId).includes(normB(c.projectId)))) return "";
  const link = tree === "pcb"
    ? (byBoard(c.pcbFolders, board) || c.pcbFolderLink || "")
    : (c.pmFolderLink || "");
  const m = String(link).match(/folders\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : "";
}

/* One line for the UI: which method this plan is built from. */
export function sourceLine() {
  if (SOURCE.from === "upload") {
    return `From ${SOURCE.fileName || "an uploaded workbook"} — uploaded${SOURCE.fetchedAt ? ` ${SOURCE.fetchedAt.slice(0, 10)}` : ""}`;
  }
  if (SOURCE.from === "drive") {
    const when = SOURCE.modifiedTime ? ` · edited ${SOURCE.modifiedTime.slice(0, 10)}` : "";
    return `From ${SOURCE.fileName || "the workbook"} in Drive${when}`;
  }
  if (SOURCE.from === "cache") {
    const when = SOURCE.fetchedAt ? ` from ${SOURCE.fetchedAt.slice(0, 10)}` : "";
    return `Drive unreachable — using the copy last read${when}${SOURCE.error ? ` (${SOURCE.error})` : ""}`;
  }
  return `Not synced from Drive yet${SOURCE.error ? ` — ${SOURCE.error}` : ""}`;
}

/* ── one project, several boards ─────────────────────────────────────────────
   A project runs once; a board runs per board. Which is which comes from the
   diagram's own tracks, because the waves already encode it: hardware and
   firmware waves follow the board (each PCB has its own schematic, its own
   layout, its own FW image — their inline tests and DFx gates joined those
   waves by number, so they follow automatically). Enclosure is one per
   product even when two boards sit inside it, and pre-design, prototype,
   pilot and mass production belong to the project.

   Changing the rule is one line — a product whose enclosure ships per board
   would add "E" here. */
export const BOARD_TRACKS = ["H", "F"];
/* The workbook can DECLARE a step's scope — the 2-PCB project copy carries a
   Scope column marking 230 steps board-level and 78 project-level, which is
   wider than the wave rule (their reference-product work runs per board even
   inside pre-design). A declared scope wins; the wave-track rule serves the
   workbooks that never say. */
export const boardScoped = (step) =>
  ["board", "board-main", "mfg-run-board"].includes(step?.scope) ? true
  : ["project", "mfg-project", "mfg-run", "mfg-run-build"].includes(step?.scope) ? false
  : BOARD_TRACKS.includes(String(step?.wave || "").charAt(0));
/* Steps that belong to the MANUFACTURING project, not the design one. */
export const mfgScoped = (step) => /^mfg-/.test(step?.scope || "");
export const boardsOf = (project) => (project?.linkedIds || []).map((x) => String(x).trim()).filter(Boolean);

/* The project workbook stays in the Project ID folder — ONE file per project,
   with one "Open — <board>" column per board. This resolves a step's own
   link for a given board: the column whose label names the board wins, and a
   lone unlabelled Open column serves a single-board project as it always
   did. Never the WRONG board's link — a near-miss falls through to none. */
const normB = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function byBoard(map, board) {
  if (!map) return "";
  const keys = Object.keys(map);
  if (board) {
    const hit = keys.find((k) => k && (normB(k).includes(normB(board)) || normB(board).includes(normB(k))));
    if (hit) return map[hit];
  }
  return map[""] || "";
}
export function openLinkFor(step, board) {
  const links = step?.openLinks || null;
  if (links && Object.keys(links).length) {
    const hit = byBoard(links, board);
    if (hit) return hit;
    const keys = Object.keys(links);
    if (!boardScoped(step) || keys.length === 1) return links[keys[0]] || "";
    return board ? "" : links[keys[0]] || "";
  }
  return step?.openLink || "";
}
export const locationFor = (step, board) => byBoard(step?.locations, board) || step?.location || "";

/* A Drive link names its file by ID — docs.google.com/document/d/<ID>/edit,
   drive.google.com/file/d/<ID>/view, …?id=<ID>. That ID is the one address
   that cannot drift, which is why the chat reads and writes THROUGH the
   step's own link and only falls back to folders when no link exists. */
export const driveFileIdOf = (url) =>
  (String(url || "").match(/\/d\/([A-Za-z0-9_-]{10,})/) ||
   String(url || "").match(/[?&]id=([A-Za-z0-9_-]{10,})/) || [])[1] || "";

/* The exact file a step's work lives in, resolved the most truthful way
   available: the step's own per-board location off the project workbook
   (which carries the REAL folder spelling and the REAL saved name), else the
   template's real name in its folder, else the idealized name. Returns the
   directory relative to the tree root, so the caller prefixes the project or
   the board path — never both, never guessed. */
export function fileTargetFor(step, projectId, board = "") {
  const loc = locationFor(step, board);
  if (loc && /\.[a-z0-9]{2,5}$/i.test(loc)) {
    const parts = String(loc).split("/").filter(Boolean);
    const name = parts.pop();
    /* The first segment often names the project or board folder itself —
       that is the tree root's job, so it comes off here. The order of these
       two tests is load-bearing: the project id is a PREFIX of the full board
       id (EbX-…-1880 vs EbX-…-1880-GW-123), so a loose "board contains this
       segment" test would claim the project's own folder for the board and
       send a project-management file into a PCB tree. The project is tested
       first and EXACTLY; only then may the segment be the board's. */
    const nf = normB(parts[0] || "");
    const np = normB(projectId || "");
    const nb = normB(board || "");
    const isProjSeg = !!np && !!nf && nf === np;
    const isBoardSeg = !isProjSeg && !!nb && !!nf && (nf === nb || nb.endsWith(nf) || nf.endsWith(nb));
    if (isBoardSeg || isProjSeg) parts.shift();
    return { name, relDir: parts.join("/"),
             tree: isBoardSeg ? "pcb" : isProjSeg ? "pm" : (servesOf(step) === "pcb" ? "pcb" : "pm") };
  }
  const t = templateFor(step);
  return {
    name: t?.fileNameReal || fileNameFor(step, projectId, board),
    relDir: (folderFor(step) || "").replace(/\/+$/, ""),
    tree: servesOf(step) === "pcb" ? "pcb" : "pm",
  };
}

export const stepByNo = (no) => STEPS.find((s) => s.no === Number(no)) || null;
export const stepsIn = (category) => STEPS.filter((s) => s.category === category);

/* ── where a step's file actually goes ───────────────────────────────────────
   The workbook writes filenames as [ProjectID]_Thing-Name and keeps the folder
   with the template. Together they are the exact address of the artefact the
   step must produce — which is what lets somebody do the work without opening
   Drive to hunt for the right folder first.                                  */
export const fileNameFor = (step, projectId, pcbId) =>
  String(step?.templateFile || "")
    .replace(/\[ProjectID\]/g, projectId || "[ProjectID]")
    // Engineering artefacts are named after the BOARD, not the project — a
    // project with three boards produces three of these files and they are
    // told apart by nothing else.
    .replace(/\[PCB-?ID\]/gi, pcbId || "[PCB-ID]");

export const folderFor = (step) => TEMPLATES[step?.templateId]?.folder || "";

/* ── the template itself ─────────────────────────────────────────────────────
   The template register carries a link straight to the file in Drive, what the
   filled-in copy should be called, and what a good one looks like. A step that
   can hand somebody the blank template and the standard it will be judged
   against is a step they can do without asking anybody first.                */
export const templateFor = (step) => TEMPLATES[step?.templateId] || null;
/* ── the links, verified against Drive ───────────────────────────────────────
   The register stores a hyperlink per template, and that hyperlink is a
   MEMORY. The day somebody cleans Drive up, the register keeps pointing at
   the trash — EB-T-133's link opened a file sitting in the owner's bin. A
   link handed to somebody mid-task is an instruction, so it cannot be wrong:
   the only links this module ever returns are the ones Drive itself confirmed
   alive, and until that has happened it returns none at all. The sheet's name
   still shows; a missing link is an inconvenience, a wrong one is a trap.   */
const LINKS_KEY = "eb-template-links-v1";
export const LINKS = { at: "", count: 0, duplicates: [], links: null, error: "" };

function rememberLinks() {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify({ at: LINKS.at, count: LINKS.count, duplicates: LINKS.duplicates, links: LINKS.links })); }
  catch { /* quota — the session copy still works */ }
}
try {
  const cached = JSON.parse(localStorage.getItem(LINKS_KEY) || "null");
  if (cached?.links && Object.keys(cached.links).length) Object.assign(LINKS, cached, { error: "" });
} catch { /* no localStorage here (tests, SSR) — links stay unverified */ }

export function applyTemplateLinks(r) {
  if (r?.error || !r?.links) { LINKS.error = String(r?.error || "Drive returned nothing"); return LINKS; }
  Object.assign(LINKS, { links: r.links, count: r.count || Object.keys(r.links).length,
                         duplicates: r.duplicates || [], at: r.fetchedAt || new Date().toISOString(), error: "" });
  rememberLinks();
  return LINKS;
}

/* Fetch-and-apply, at most once per session unless forced by the button. */
let linksLoading = null;
export function loadTemplateLinks(readDrive, { force = false } = {}) {
  if (typeof readDrive !== "function") return Promise.resolve(LINKS);
  if (!force && linksLoading) return linksLoading;
  linksLoading = (async () => {
    try { return applyTemplateLinks(await readDrive({ action: "template_links" })); }
    catch (e) { LINKS.error = String(e?.message || e); return LINKS; }
  })();
  return linksLoading;
}

export const templateLink = (step) => {
  const id = step?.templateId;
  return (id && LINKS.links?.[id]?.link) || "";
};
export const templateLinkFor = (id) => LINKS.links?.[id] || null;
/* One line for the UI: are the links trustworthy right now, and since when. */
export function linksLine() {
  if (LINKS.links) {
    const dup = LINKS.duplicates.length ? ` · ${LINKS.duplicates.length} id${LINKS.duplicates.length === 1 ? " has" : "s have"} two live copies in Drive` : "";
    return `${LINKS.count} sheet links verified against Drive${LINKS.at ? ` · ${LINKS.at.slice(0, 16).replace("T", " ")}` : ""}${dup}`;
  }
  return LINKS.error ? `Links not verified — ${LINKS.error}` : "Links not verified against Drive yet";
}
export const templateStandard = (step) => templateFor(step)?.whatGood || "";
export const templateLibraryFolder = (step) => templateFor(step)?.library || "";

/* Whether we actually know where this step's output belongs. A template the
   workbook uses but never defines in its Template Actions tab has no folder,
   and guessing one would put somebody's work in the wrong place with total
   confidence. Callers show the gap instead. */
export const knowsWhereItGoes = (step) => !!folderFor(step);

/* ── which folder a step's file belongs in ───────────────────────────────────
   There are TWO trees, not one. The project folder under Project Management
   holds the PM-side artefacts; the PCB-ID folder under PCB & Firmware holds
   the engineering ones. 128 of the 308 steps write to the PCB-ID folder and 71
   to the project folder — showing all of them under one root sends more than a
   third of the work to a folder that will never hold it.

   The template register is what knows which: its "Serves" column says PCB ID
   folder, Project Management folder, or Both. Both means the artefact has a
   home in each tree, and both are shown rather than one being picked. */
export function servesOf(step) {
  const t = templateFor(step);
  /* The template library's own first folder is the answer and it is never
     ambiguous: 01-Project-ID-Folder-PM or 02-PCB-ID-Folder-Engineering. Those
     two trees were copied whole into every project, so where the blank sits in
     the library is exactly where the project's copy sits. The register's
     "Serves" column is a second opinion, used only when there is no library
     path to read. */
  if (t?.tree === "pcb" || t?.tree === "pm") return t.tree;
  const v = String(t?.serves || "").toLowerCase();
  if (/both/.test(v)) return "both";
  if (/pcb/.test(v)) return "pcb";
  if (/project|management/.test(v)) return "pm";
  return "";
}

/* The full path (or paths), given the two roots the app already knows as
   pmPath(projectId) and pcbPath(boardId). Kept as one function so a path never
   gets assembled two different ways in two different screens. */
export function pathsFor(step, projectId, roots = {}, pcbId = "") {
  const folder = folderFor(step);
  if (!folder) return [];
  const name = fileNameFor(step, projectId, pcbId);
  const join = (root) => `${String(root || "").replace(/\/+$/, "")}/${folder}${name}`.replace(/\/{2,}/g, "/");
  const serves = servesOf(step);
  const out = [];
  // The project folder is the fallback root: a template the register says
  // nothing about is a PM artefact until somebody says otherwise, and that is
  // the tree a PM will look in first.
  if (serves !== "pcb" && roots.pm) out.push({ where: "project folder", path: join(roots.pm) });
  if (serves !== "pm" && roots.pcb) out.push({ where: "PCB-ID folder", path: join(roots.pcb) });
  if (!out.length && roots.pm) out.push({ where: "project folder", path: join(roots.pm) });
  return out;
}

export function pathFor(step, projectId, projectRoot = "", pcbId = "") {
  const roots = typeof projectRoot === "string" ? { pm: projectRoot } : (projectRoot || {});
  return pathsFor(step, projectId, roots, pcbId)[0]?.path || "";
}

/* ── who does it ─────────────────────────────────────────────────────────────
   The workbook names FUNCTIONS ("Solution Architect / Project Manager",
   "Testing / Hardware"), and the roster holds PEOPLE with resource roles. This
   maps one to the other. Order matters: the first function named is the one
   that actually performs the step, the rest are along for review — so the
   first that matches somebody on this project's team wins.                   */
const FUNCTION_ROLES = [
  [/solution architect/i, ["sol_arch"]],
  [/firmware/i, ["sr_fw", "jr_fw"]],
  [/hardware/i, ["sr_hw", "jr_hw"]],
  [/enclosure|industrial|mechanical/i, ["ind_design"]],
  [/testing|\btest\b|\bqa\b/i, ["tester"]],
  [/soldering|assembly/i, ["soldering"]],
  [/procurement|supply|sourcing|costing|vendor/i, ["sc"]],
  [/devops|\bit\b/i, ["devops"]],
  [/project manager|\bpm\b|product|management|sales|engineering lead|department lead/i, ["sr_pm", "jr_pm"]],
  [/engineering|engineer/i, ["sr_hw", "jr_hw", "sr_fw", "jr_fw"]],
];

/* The resource roles a step's responsibility asks for, most-responsible
   first. */
export function rolesForStep(step) {
  const parts = String(step?.responsibility || "").split("/").map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    for (const [re, roles] of FUNCTION_ROLES) {
      if (re.test(part)) { for (const r of roles) if (!out.includes(r)) out.push(r); break; }
    }
  }
  return out;
}

/* The person on THIS project who should do this step. A project's own team is
   the only place the answer lives — the hardware engineer on one project is
   not the hardware engineer on another. Falls back to the project's PM,
   because the workbook makes the PM accountable for every step; returns "" if
   even that is missing rather than inventing an owner. */
export function whoDoes(step, project, users) {
  const team = project?.team || [];
  const roleOf = (m) => users.find((u) => String(u.id) === String(m.userId))?.resourceRole || "";
  for (const want of rolesForStep(step)) {
    const hit = team.find((m) => roleOf(m) === want);
    if (hit) return String(hit.userId);
  }
  // The slot text is the other clue: "Jr. Hardware Engineer" on the team.
  for (const want of rolesForStep(step)) {
    const hit = team.find((m) => new RegExp(want.replace(/^(sr|jr)_/, ""), "i").test(m.slot || ""));
    if (hit) return String(hit.userId);
  }
  return String(team.find((m) => /^PM/i.test(m.slot || ""))?.userId || "");
}

/* ── when it happens ─────────────────────────────────────────────────────────
   The plan's dates come from the project's own milestones, not from a guess.

   Two rules decide the shape. Phases run in order — nothing in Prototype
   starts before Pre-design has finished. But the three design tracks
   (hardware, firmware, enclosure) run AT THE SAME TIME, which the Flow Map
   states outright; laying them end to end would invent months of schedule that
   do not exist and make every date wrong from day one.

   Inside a lane, steps are spread evenly by count. That is deliberately crude:
   it is a starting plan a PM then adjusts, not a claim about how long a
   particular step takes.                                                     */
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

/* Working days only — a plan that schedules work on Sundays is one nobody
   believes by the second week. */
function addWorkingDays(from, n) {
  const d = new Date(from);
  let left = Math.max(0, Math.round(n));
  while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0) left--; }
  return d;
}
function workingDaysBetween(a, b) {
  let n = 0;
  const d = new Date(a), end = new Date(b);
  while (d < end) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0) n++; }
  return n;
}

/* Phases, in order, with the parallel tracks collapsed into one span. */
export function phasesOf(categories = CATEGORIES) {
  const byPhase = new Map();
  for (const c of categories) {
    if (!byPhase.has(c.phase)) byPhase.set(c.phase, { phase: c.phase, categories: [], steps: 0, span: 0 });
    const p = byPhase.get(c.phase);
    p.categories.push(c);
    p.steps += c.count;
    // Concurrent tracks share a window, so the phase is only as long as its
    // longest track — not the sum of all three.
    p.span = p.categories.some((x) => x.parallel)
      ? Math.max(...p.categories.filter((x) => x.parallel).map((x) => x.count),
                 ...p.categories.filter((x) => !x.parallel).map((x) => x.count), 0)
      : p.steps;
  }
  return [...byPhase.values()].sort((a, b) => a.phase - b.phase);
}

export let WAVES = MAP.waves || [];
export const waveById = (id) => WAVES.find((w) => w.id === id) || null;
export const waveOf = (stepNo) => WAVES.find((w) => w.steps.includes(Number(stepNo))) || null;

/* ── the real schedule: waves ────────────────────────────────────────────────
   The flow diagram carries what the workbook cannot — the dependency graph. A
   wave holds steps with no dependency on each other, so they all start
   together; a wave's predecessors are fixed. Hardware, firmware and enclosure
   all begin after the last pre-design wave, and the prototype merge waits on
   ALL THREE: pulling firmware in early does not move it.

   That is a critical path, not a spread. Every wave gets one working day per
   step in its longest chain, then the whole thing is stretched or squeezed to
   fit the project's actual window — so the SHAPE comes from the process and
   the LENGTH from the dates the business committed to.                       */
export function scheduleWaves({ start, end, milestones = [] }) {
  if (!WAVES.length) return null;

  // Earliest finish for each wave, in abstract units, honouring predecessors.
  const cost = (w) => Math.max(1, w.steps.length);
  const startAt = new Map(), endAt = new Map();
  const settle = (w, guard = 0) => {
    if (endAt.has(w.id)) return endAt.get(w.id);
    if (guard > WAVES.length) return 0;              // a cycle would hang this
    const after = (w.after || []).map(waveById).filter(Boolean);
    const from = after.length ? Math.max(...after.map((p) => settle(p, guard + 1))) : 0;
    startAt.set(w.id, from);
    const to = from + cost(w);
    endAt.set(w.id, to);
    return to;
  };
  for (const w of WAVES) settle(w);

  const span = Math.max(1, Math.max(...endAt.values()));
  return { startAt, endAt, span, milestones };
}

/* Dates for every step. `milestones` is optional: a list of
   { category | phase, date } from the project's Milestone Tracking Sheet. Any
   phase named there is pinned to that date and the rest flow around it. */
export function scheduleSteps({ start, end, milestones = [], steps = STEPS, categories = CATEGORIES }) {
  const t0 = new Date(start || iso(Date.now()));
  const t1 = new Date(end || addDays(t0, 180));
  const totalDays = Math.max(workingDaysBetween(t0, t1), phasesOf(categories).length);

  /* The wave graph is the truth when we have it: it knows that H, F and E run
     together and that the merge waits on all three. The category spread below
     is the fallback for a partial plan (one category asked for on its own),
     where there is no graph to walk. */
  const graph = steps === STEPS ? scheduleWaves({ start, end, milestones }) : null;
  if (graph) {
    /* Abstract wave units → real dates, through the milestones as ANCHORS.
       A milestone is a date the business has committed to, so the wave that
       ends there is pinned to it and the stretches either side absorb the
       difference. Interpolating between anchors is what makes a late milestone
       push everything after it out and an early one pull it in, without ever
       moving the milestone itself. */
    const anchors = [[0, 0]];
    for (const m of milestones) {
      if (!m.date) continue;
      const cat = m.category || CATEGORIES.find((c) => c.phase === m.phase)?.name;
      const waves = WAVES.filter((w) => w.category === cat);
      if (!waves.length) continue;
      const unit = Math.max(...waves.map((w) => graph.endAt.get(w.id) || 0));
      anchors.push([unit, workingDaysBetween(t0, new Date(m.date))]);
    }
    anchors.push([graph.span, totalDays]);
    anchors.sort((a, b) => a[0] - b[0]);
    const toDays = (u) => {
      for (let i = 1; i < anchors.length; i++) {
        const [u0, d0] = anchors[i - 1], [u1, d1] = anchors[i];
        if (u <= u1 || i === anchors.length - 1) {
          const t = u1 === u0 ? 0 : (u - u0) / (u1 - u0);
          return d0 + t * (d1 - d0);
        }
      }
      return u;
    };

    const out = new Map();
    for (const w of WAVES) {
      const a = addWorkingDays(t0, toDays(graph.startAt.get(w.id) || 0));
      const b = addWorkingDays(t0, toDays(graph.endAt.get(w.id) || 1));
      for (const no of w.steps) {
        const s = stepByNo(no);
        const cat = categories.find((c) => c.name === s?.category);
        // Every step in a wave starts together — that is what a wave means.
        out.set(no, { start: iso(a), end: iso(b), phase: cat?.phase, category: s?.category,
                      parallel: !!cat?.parallel, wave: w.id });
      }
    }
    // A step the diagram never placed still needs a date rather than nothing.
    for (const s of steps) if (!out.has(s.no)) {
      const cat = categories.find((c) => c.name === s.category);
      out.set(s.no, { start: iso(t0), end: iso(t1), phase: cat?.phase, category: s.category, parallel: !!cat?.parallel, wave: "" });
    }
    return out;
  }

  const phases = phasesOf(categories);
  const weight = phases.reduce((s, p) => s + p.span, 0) || 1;

  // Where each phase starts and ends, before milestones are applied.
  let cursor = 0;
  const window = new Map();
  for (const p of phases) {
    const days = Math.max(1, Math.round((p.span / weight) * totalDays));
    window.set(p.phase, { from: cursor, to: cursor + days });
    cursor += days;
  }

  /* A milestone is a fact, not a suggestion: if the sheet says the design
     review is on the 14th, that phase ENDS on the 14th and everything after it
     shifts. */
  for (const m of milestones) {
    const phase = m.phase ?? categories.find((c) => c.name === m.category)?.phase;
    const w = window.get(phase);
    if (!w || !m.date) continue;
    const at = workingDaysBetween(t0, new Date(m.date));
    const shift = at - w.to;
    if (!shift) continue;
    for (const [ph, ww] of window) {
      if (ph === phase) ww.to += shift;
      else if (ph > phase) { ww.from += shift; ww.to += shift; }
    }
  }

  /* Inside a phase every concurrent track gets the WHOLE phase window and
     spreads its own steps across it; a serial category takes its share. */
  const out = new Map();
  for (const p of phases) {
    const w = window.get(p.phase);
    const span = Math.max(1, w.to - w.from);
    const serial = p.categories.filter((c) => !c.parallel);
    const serialTotal = serial.reduce((s, c) => s + c.count, 0) || 1;
    let serialCursor = w.from;

    for (const c of p.categories) {
      const catSteps = steps.filter((s) => s.category === c.name).sort((a, b) => a.no - b.no);
      const from = c.parallel ? w.from : serialCursor;
      const to = c.parallel ? w.to : serialCursor + Math.max(1, Math.round((c.count / serialTotal) * span));
      if (!c.parallel) serialCursor = to;

      const each = Math.max(1, (to - from) / Math.max(1, catSteps.length));
      catSteps.forEach((s, i) => {
        const a = addWorkingDays(t0, from + i * each);
        const b = addWorkingDays(t0, from + (i + 1) * each);
        out.set(s.no, { start: iso(a), end: iso(b), phase: p.phase, category: c.name, parallel: !!c.parallel });
      });
    }
  }
  return out;
}

/* ── the plan ────────────────────────────────────────────────────────────────
   The whole thing together: every step of the method, dated, addressed to a
   person, with the exact file it must produce and where that file goes. This
   is what the project plan and the work window both read.                    */
export function buildPlan(project, users = [], opts = {}) {
  const projectId = project?.projectId || "";
  const start = opts.start || project?.startDate || (project?.createdAt || "").slice(0, 10) || iso(Date.now());
  const end = opts.end || project?.deadline || "";
  const only = opts.categories ? new Set(opts.categories) : null;
  // A project can carry several boards; the first is the one the steps that
  // name [PCB-ID] belong to unless a caller says otherwise.
  const boards = opts.boards || boardsOf(project);
  const multi = boards.length > 1;
  const pcbId = opts.pcbId || boards[0] || "";
  const rootsFor = (board) => ({
    pm: opts.projectRoot || "",
    pcb: typeof opts.pcbRootFor === "function" ? (board ? opts.pcbRootFor(board) : "") : (opts.pcbRoot || ""),
  });

  /* A v11 map carries the WHOLE method — design and manufacturing. A design
     project plans the design side; a manufacturing project (kind "mfg")
     plans the manufacturing side. A map with no mfg steps planned everything
     for everyone before, and still does. */
  const kind = project?.kind || opts.kind || "design";
  const hasMfg = STEPS.some(mfgScoped);
  let steps = only ? STEPS.filter((s) => only.has(s.category)) : STEPS;
  if (hasMfg) steps = steps.filter((s) => (kind === "mfg" ? mfgScoped(s) : !mfgScoped(s)));
  const categories = only ? CATEGORIES.filter((c) => only.has(c.name)) : CATEGORIES;
  const when = scheduleSteps({ start, end, milestones: opts.milestones || [], steps, categories });
  /* Product-level work happens once, on the MAIN board — declared at setup. */
  const mainBoard = (() => {
    const metas = project?.boards || [];
    const m = metas.find((b) => b.main);
    const id = m ? (m.sku || m.ref) : "";
    return (id && boards.find((b) => String(b).toUpperCase() === String(id).toUpperCase())) || boards[0] || "";
  })();

  /* A board-scoped step on a two-board project is two pieces of work: two
     schematics, two DRC gates, two fab releases — each with its own file, its
     own link, its own status. They share the wave's dates, which is exactly
     right: the boards' tracks run concurrently, like every concurrent track
     in this process. Project-scoped steps stay single whatever the board
     count, and a single-board project builds the same plan it always did. */
  return steps.flatMap((s) => {
    const w = when.get(s.no) || {};
    /* Board-Main is board work that runs ONCE — on the MAIN board, never a
       lane per board. Everything else board-scoped instances per board. */
    const perBoard = multi && boardScoped(s) && s.scope !== "board-main";
    const instances = perBoard ? boards : (multi && s.scope === "board-main") ? [mainBoard] : [""];
    return instances.map((board) => {
      const useBoard = board || pcbId;
      const roots = rootsFor(useBoard);
      return {
      key: board ? `${s.no}:${board}` : String(s.no),
      board,
      boardScoped: boardScoped(s),
      no: s.no,
      /* Category, step, template id and responsibility travel together — those
         four are what makes a plan row actionable rather than a name on a
         list: which part of the process this is, what it is, which document it
         writes to, and whose job it is. Every view that prints the plan prints
         all four. */
      category: s.category,
      phase: w.phase,
      block: s.block || "",
      blockName: blockById(s.block)?.label || "",
      title: board ? `${s.step} — ${board}` : s.step,
      action: s.action,
      template: s.template,
      templateId: s.templateId,
      // The sheet's actual name, from the register. A template id on its own
      // tells nobody what they are about to open.
      templateName: templateFor(s)?.name || "",
      // Deliberately NOT the template link: rows are memoised and those are
      // verified against Drive after the fact — render-time lookups only. The
      // step's OWN links are different: they came off the project workbook
      // somebody deliberately built, and they are the row's payload.
      openLink: openLinkFor(s, board),
      masterLink: s.masterLink || "",
      location: locationFor(s, board),

      templateStandard: templateStandard(s),
      // Where the parallel tracks have to stop and agree before this can close.
      converge: s.converge || null,
      fileName: fileNameFor(s, projectId, useBoard),
      folder: folderFor(s),
      // Every place this step's file belongs — one for most steps, two for the
      // 109 whose template serves the project folder AND the board folder.
      paths: knowsWhereItGoes(s) ? pathsFor(s, projectId, roots, useBoard) : [],
      path: knowsWhereItGoes(s) ? pathsFor(s, projectId, roots, useBoard)[0]?.path || "" : "",
      serves: servesOf(s),
      // Named so a screen can say WHY there is no path rather than showing a
      // blank and letting somebody assume the file has no home.
      folderUnknown: knowsWhereItGoes(s) ? "" : (s.templateId || "the template"),
      entryTrigger: s.entryTrigger,
      exitTrigger: s.exitTrigger,
      entryQuestion: s.entryQuestion,
      exitQuestion: s.exitQuestion,
      whatToDo: s.whatToDo,
      guidelines: s.guidelines,
      responsibility: s.responsibility,
      assigneeId: whoDoes(s, project, users),
      start: w.start || start,
      end: w.end || end,
      parallel: !!w.parallel,
      wave: w.wave || "",
      };
    });
  });
}

/* What one person has to do on a project, in order — the "my tasks for the
   whole duration" view a PM asked for. */
export const planFor = (plan, userId) =>
  plan.filter((p) => String(p.assigneeId) === String(userId)).sort((a, b) => a.start.localeCompare(b.start) || a.no - b.no);

/* Everything that writes to one template, so a person opening a file can see
   every step that will touch it rather than just their own. */
export const stepsTouching = (templateId) => (TEMPLATES[templateId]?.steps || []).map(stepByNo).filter(Boolean);

/* ── which process step a task actually is ───────────────────────────────────
   Tasks are raised from the scrum, from client calls and by hand, so most
   carry a title somebody typed rather than a step number. Matching on the
   words is how the work window can show a task the method behind it without
   waiting for every task to be created from the plan.

   It is deliberately strict. A wrong match would show somebody the guidance,
   the file and the Drive path for a DIFFERENT piece of work, which is worse
   than showing none — so a weak overlap returns nothing and the window falls
   back to what it always showed. */
export function matchStep(task) {
  // 0 is "the words got this wrong" — somebody said so, so never guess again.
  if (task?.stepNo === 0) return null;
  if (task?.stepNo) return stepByNo(task.stepNo);
  const words = (s) => new Set(String(s || "").toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    // "the", "of", "and" match everything and mean nothing.
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "all", "any", "its", "from", "into", "this", "that", "pending"].includes(w)));
  const want = words(task?.title);
  if (want.size < 2) return null;

  let best = null, bestScore = 0;
  for (const s of STEPS) {
    const have = words(s.step);
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    // Both directions: a long task title should not beat a short step name
    // just by containing more words.
    const score = hit / Math.max(want.size, have.size);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // Half the significant words in common, or it is a guess.
  return bestScore >= 0.5 ? best : null;
}
