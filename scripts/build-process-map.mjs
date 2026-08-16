#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   THE PROCESS MAP, TURNED INTO DATA
   ───────────────────────────────────────────────────────────────────────────
   EbODM_Master_Process_Flow is the company's actual method: 305 steps, what
   opens and closes each one, the question that must be answerable before it
   starts, the template it writes to and where that template lives, and how to
   do it. As a spreadsheet it is a reference nobody opens mid-task. As data it
   becomes the plan every project is built from and the guidance shown in the
   work window.

   This regenerates src/data/process-map.json from the workbook:

     node scripts/build-process-map.mjs <path to the .xlsx>

   Re-run it whenever the master sheet changes. Nothing else reads the
   spreadsheet — the JSON is the single source in the app.
   ═══════════════════════════════════════════════════════════════════════════ */
import XLSX from "xlsx";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/* Arguments are taken by KIND, not by position: the workbook and the template
   index are both .xlsx and it is far too easy to hand them over the wrong way
   round. The first workbook with a "Process Flow" tab is the master; the one
   with an "Index" tab is the template register; the .txt is the waves. */
const args = process.argv.slice(2);
let src = "", indexSrc = "", flowText = "";
for (const a of args) {
  if (/\.txt$/i.test(a)) { flowText = a; continue; }
  if (!/\.xlsx?$/i.test(a)) continue;
  const names = XLSX.readFile(a, { bookSheets: true }).SheetNames;
  if (names.includes("Process Flow")) src = a;
  else if (names.includes("Index")) indexSrc = a;
  else console.error(`  ? ignoring ${path.basename(a)} — no "Process Flow" or "Index" tab in it`);
}
if (!src) {
  console.error("Usage: node scripts/build-process-map.mjs <Master_Process_Flow.xlsx> [waves.txt] [TemplateIndex.xlsx]");
  process.exit(2);
}
const OUT = path.join(process.cwd(), "src/data/process-map.json");

const wb = XLSX.readFile(src);
const rows = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/* ── the steps ───────────────────────────────────────────────────────────── */
// Row 4 is the header; the steps start at row 5.
const flow = rows("Process Flow");
const COL = { no: 0, category: 1, step: 2, entryTrigger: 3, exitTrigger: 4, entryQuestion: 5,
              exitQuestion: 6, templateFile: 7, templateId: 8, template: 9, open: 10,
              action: 11, whatToDo: 12, owner: 13, responsibility: 14, guidelines: 15 };

const steps = [];
for (let i = 5; i < flow.length; i++) {
  const r = flow[i];
  const no = Number(clean(r[COL.no]));
  if (!Number.isFinite(no) || !clean(r[COL.step])) continue;
  steps.push({
    no,
    category: clean(r[COL.category]),
    step: clean(r[COL.step]),
    entryTrigger: clean(r[COL.entryTrigger]),
    exitTrigger: clean(r[COL.exitTrigger]),
    entryQuestion: clean(r[COL.entryQuestion]),
    exitQuestion: clean(r[COL.exitQuestion]),
    /* [ProjectID] and [PCB-ID] are substituted at the moment a plan is built.
       35 rows have the template id glued onto the front of the filename
       ("EB-T-161 · [ProjectID]_LLD-Developer_v1.0"), which is a copy-paste
       artefact and not part of any filename — left in, every one of those
       steps tells somebody to save a file under a name Drive will never
       match. The id is already in its own column. */
    templateFile: clean(r[COL.templateFile]).replace(/^EB-T-\d+\s*[·|:-]\s*/, ""),
    templateId: clean(r[COL.templateId]),
    template: clean(r[COL.template]),
    action: clean(r[COL.action]),
    whatToDo: clean(r[COL.whatToDo]),
    owner: clean(r[COL.owner]),
    responsibility: clean(r[COL.responsibility]),
    guidelines: clean(r[COL.guidelines]),
  });
}

/* ── the template library, with the folder each one lives in ─────────────── */
const ta = rows("Template Actions");
const templates = {};
for (let i = 4; i < ta.length; i++) {
  const r = ta[i];
  const id = clean(r[0]);
  if (!/^EB-T-/.test(id)) continue;
  templates[id] = {
    id,
    name: clean(r[1]),
    // The folder is relative to the project's own folder — this is what lets
    // the work window tell somebody exactly where the file goes.
    folder: clean(r[3]),
    steps: clean(r[4]).split(",").map((x) => Number(x.trim())).filter(Number.isFinite),
    actions: clean(r[6]).split("·").map((x) => x.trim()).filter(Boolean),
  };
}

/* ── the template register ───────────────────────────────────────────────────
   EbODM_TemplateIndex is the library's own register: all 178 templates, the
   exact folder each instance goes in, what the file is called, what good looks
   like — and a LINK straight to the template file in Drive. The workbook's
   Template Actions tab knows which steps touch a template; the index knows
   everything else about it. Neither is complete on its own.

   Two things it fixes outright. It defines templates the workbook uses but
   never declares (EB-T-161, the developer LLD), so those steps stop being
   homeless. And its instance paths carry the REAL Drive folder names where the
   workbook uses shorthand stems — "10-PM/03-LLD-HLD" against
   "02-Project-Folder-R&D-PM/03-LLD-HLD/01-Customer-LLD". A path is only worth
   showing somebody if it is the path they will actually find.                */
const templateNotes = [];
if (indexSrc) {
  const ib = XLSX.readFile(indexSrc);
  const sheet = ib.Sheets["Index"];
  const ir = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  // "Open" is a word in a cell; the thing worth having is the hyperlink under
  // it, which is a direct Drive link to the template file.
  const links = {};
  for (const addr in sheet) {
    if (addr[0] === "!") continue;
    const cell = sheet[addr];
    if (cell?.l?.Target && /^EB-T-/.test(String(cell.v || ""))) links[String(cell.v)] = cell.l.Target;
  }
  const IX = { id: 0, name: 1, format: 3, kind: 4, description: 5, whatGood: 6, serves: 7,
               library: 8, instancePath: 9, instanceName: 10, stage: 11, createdAt: 12,
               editedAt: 13, owner: 14, filledBy: 15, auditRow: 16, version: 17 };
  let added = 0, enriched = 0, refined = 0, moved = 0;
  for (let i = 0; i < ir.length; i++) {
    const r = ir[i];
    const id = clean(r[IX.id]);
    if (!/^EB-T-/.test(id)) continue;
    const instance = clean(r[IX.instancePath]);
    /* A few rows put the FILE in the instance-path column. A file is not a
       folder, and treating one as the other would drop everything that step
       writes into the folder above it. The library column has the folder in
       those cases — one segment deeper, because it is written from the top of
       the project rather than from inside it, so that root is taken off. */
    const library = clean(r[IX.library]).replace(/^0[12]-(Project-ID-Folder-PM|PCB-ID-Folder-Engineering)\//, "");
    const folder = /\.[a-z0-9]{2,5}$/i.test(instance) ? library : instance;
    const t = templates[id];
    if (!t) {
      templates[id] = { id, name: clean(r[IX.name]), folder, steps: [], actions: [] };
      added++;
    } else {
      if (folder && folder.replace(/\/+$/, "") !== t.folder.replace(/\/+$/, "")) {
        (folder.startsWith(t.folder.replace(/\/+$/, "") + "/") ? () => refined++ : () => moved++)();
        t.folder = folder;
      }
      enriched++;
    }
    Object.assign(templates[id], {
      format: clean(r[IX.format]),
      kind: clean(r[IX.kind]),
      description: clean(r[IX.description]),
      whatGood: clean(r[IX.whatGood]),
      serves: clean(r[IX.serves]),
      library: clean(r[IX.library]),
      instanceName: clean(r[IX.instanceName]),
      stage: clean(r[IX.stage]),
      owner: clean(r[IX.owner]),
      filledBy: clean(r[IX.filledBy]),
      auditRow: clean(r[IX.auditRow]),
      version: clean(r[IX.version]),
      link: links[id] || "",
    });
  }
  const linked = Object.values(templates).filter((t) => t.link).length;
  templateNotes.push(`template index: ${enriched + added} templates read · ${added} the workbook never declared · ${linked} link straight to Drive`);
  if (refined) templateNotes.push(`${refined} folder(s) made more exact by the index`);
  if (moved) templateNotes.push(`${moved} folder(s) DISAGREE between the workbook and the index — the index won, because it carries the real Drive folder names`);
  // Duplicates are a Drive problem, not a data problem, but the register knows
  // about them and nobody reads the register.
  const dup = XLSX.utils.sheet_to_json(ib.Sheets["Duplicates in Drive"] || {}, { header: 1, defval: "" });
  const dupIds = [...new Set(dup.map((r) => clean(r[0])).filter((x) => /^EB-T-/.test(x)))];
  if (dupIds.length) templateNotes.push(`${dupIds.length} template id(s) resolve to two files in Drive — delete the spare: ${dupIds.join(", ")}`);
} else {
  templateNotes.push("no template index given — folders come from the workbook alone, and templates it never declares have none");
}

/* ── how the process splits and merges ───────────────────────────────────────
   The Flow Map tab is the only place that names the MAJOR BLOCKS and fixes
   their sequence: what runs serially, which three tracks run at the same time,
   which gate blocks what, and the points where the parallel tracks have to
   stop and agree with each other before any of them can go on.

   It is read whole. The old reader took the block table and stopped at TOTAL,
   which silently dropped the cross-track convergence section underneath it —
   the sheet grew a section and the app never noticed. Every non-empty row is
   now claimed by a section or listed in `unread` and printed, so a row added
   in Drive can never go quietly missing again.                               */
const fm = rows("Flow Map");
const nonEmpty = (r) => (r || []).some((c) => clean(c));
const cells = (r) => (r || []).map(clean);
const rowText = (r) => cells(r).filter(Boolean).join(" ");

const blocks = [];
const convergence = [];
const unread = [];
let declaredTotal = null;
let flowTitle = "";

{
  let section = "";                 // "" | blocks | convergence
  for (let i = 0; i < fm.length; i++) {
    const r = fm[i], c = cells(r);
    if (!nonEmpty(r)) { continue; }
    const label = `row ${i + 1}`;

    // Headers switch the section on. Matching on the header's own words rather
    // than a row number means inserting a row in Drive cannot break this.
    if (c[0] === "Block" && /categor/i.test(c[1] || "")) { section = "blocks"; continue; }
    if (/convergence step/i.test(c[1] || "")) { section = "convergence"; continue; }
    if (/^cross-track convergence/i.test(c[0] || "")) { section = ""; continue; }
    if (i === 0 && /flow structure/i.test(c[0] || "")) { flowTitle = c[0]; continue; }

    if (section === "blocks") {
      if (/^TOTAL$/i.test(c[0]) || /^TOTAL$/i.test(c[2])) {
        declaredTotal = Number(c.find((x, k) => k > 0 && /^\d+$/.test(x))) || null;
        section = "";
        continue;
      }
      if (!c[0] || !c[1]) { unread.push(`${label}: ${rowText(r).slice(0, 70)}`); continue; }
      /* "A — Serial" is a GROUP, not a name — three rows share "B — Parallel".
         The block's own name is its category with the leading phase number
         stripped, which is what a person actually calls it out loud. */
      const group = (c[0].match(/^([A-Z])\b/) || [])[1] || "";
      const kind = clean(c[0].replace(/^[A-Z]\s*[—–-]\s*/, "")) || "Serial";
      const name = clean(c[1].replace(/^\d+\s*·\s*/, "")) || c[1];
      blocks.push({
        seq: blocks.length + 1,
        id: `${group || "X"}${blocks.filter((b) => b.group === group).length + 1}`,
        group, kind, name,
        label: `${group}${blocks.filter((b) => b.group === group).length + 1} · ${name}`,
        block: c[0],                       // kept: older readers key off this
        category: c[1],
        sourceRows: c[2] || "",
        steps: Number(c[3]) || 0,
        runs: c[4] || "",
        convergesWith: c[5] || "",
      });
      continue;
    }

    if (section === "convergence") {
      if (!c[1]) { unread.push(`${label}: ${rowText(r).slice(0, 70)}`); continue; }
      convergence.push({
        n: Number(c[0]) || convergence.length + 1,
        // "Prototype Checklist (row 126)" — the row number is a pointer into an
        // older revision of the sheet and goes stale; the name does not.
        name: clean(c[1].replace(/\s*\(row\s*\d+\)\s*$/i, "")),
        tracks: c[2] || "",
        agree: c[3] || "",
        merge: /merge/i.test(c[2] || ""),
        steps: [],                         // filled in once the steps are read
      });
      continue;
    }

    // Prose between sections is fine and expected; anything else is a row the
    // reader does not understand, and it gets said out loud.
    if (c.filter(Boolean).length === 1 && c[0] && c[0].length > 30) continue;
    unread.push(`${label}: ${rowText(r).slice(0, 70)}`);
  }
}

/* Categories in the order the process actually runs them. The leading digit in
   the category name is the phase, so several categories share a phase — the
   three design tracks are all phase 2 and run at the same time. */
const categories = [];
for (const s of steps) {
  let c = categories.find((x) => x.name === s.category);
  if (!c) {
    const phase = Number((s.category.match(/^(\d+)/) || [])[1]) || 99;
    c = { name: s.category, phase, count: 0, first: s.no, last: s.no };
    categories.push(c);
  }
  c.count++;
  c.first = Math.min(c.first, s.no);
  c.last = Math.max(c.last, s.no);
}
categories.sort((a, b) => a.phase - b.phase || a.first - b.first);

/* Which categories run at the same time as each other. The Flow Map calls
   these "Concurrent track" — a plan that laid them end to end would invent
   months of schedule that do not exist. */
for (const c of categories) {
  const b = blocks.find((x) => x.category === c.name);
  c.parallel = /concurrent/i.test(b?.runs || "");
  c.gated = /gated/i.test(b?.runs || "");
  c.runs = b?.runs || "";
  c.block = b?.id || "";
}

/* Every block must land on a real category and every category must sit in a
   block, or the sequence has a hole in it that nothing downstream can see. The
   one legitimate split is Test: the Flow Map draws it twice — inline per track
   and again after the merge — where the workbook has a single category.      */
const blockNotes = [];
for (const b of blocks) {
  if (categories.some((c) => c.name === b.category)) continue;
  const stem = b.category.replace(/\s*\([^)]*\)\s*$/, "");
  const c = categories.find((x) => x.name === stem);
  if (c) { b.category = c.name; b.split = true; b.as = b.name; }
  else blockNotes.push(`block "${b.label}" names a category the Process Flow tab does not have: "${b.category}"`);
}
for (const c of categories) {
  if (!blocks.some((b) => b.category === c.name)) blockNotes.push(`category "${c.name}" (${c.count} steps) is in no block — the Flow Map does not say where it runs`);
}
{
  const counted = blocks.reduce((s, b) => s + b.steps, 0);
  if (counted !== steps.length) blockNotes.push(`the blocks add up to ${counted} steps but the Process Flow tab has ${steps.length}`);
  if (declaredTotal != null && declaredTotal !== counted) blockNotes.push(`the Flow Map's own TOTAL says ${declaredTotal}, its blocks add up to ${counted}`);
}
// Two blocks can share a category (Test), so the split blocks are told apart
// by their own name rather than by the category they belong to.
for (const b of blocks) {
  const same = blocks.filter((x) => x.category === b.category);
  b.sharesCategory = same.length > 1;
}

/* ── the convergence points ──────────────────────────────────────────────────
   Four words in a spreadsheet — "the three parallel tracks must synchronise
   here" — are the difference between a plan that works and one that quietly
   lets hardware finish its layout against an enclosure nobody agreed to. Each
   row is resolved to the ACTUAL steps it names, in every track that has one.

   A row can name more than one step: "Concept / CAD / render reviews with HW
   team" is four separate enclosure reviews. And a row can name a track that
   has no step for it at all — the sheet says enclosure must be at the block
   diagram review and the enclosure track has nothing there. Both are reported
   rather than smoothed over, because an unenforceable constraint that looks
   enforced is worse than a missing one.                                      */
const TRACK_CATEGORY = {
  HW: "2 · Design — Hardware", FW: "2 · Design — Firmware", ENC: "2 · Design — Enclosure",
};
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
for (const cv of convergence) {
  cv.trackKeys = [...new Set((cv.tracks.match(/HW|FW|ENC/g) || []))];
  const exact = steps.filter((s) => normName(s.step) === normName(cv.name));
  if (exact.length) cv.steps = exact.map((s) => s.no);
  else {
    /* No exact row. The sheet is describing a GROUP of reviews — "Concept /
       CAD / render reviews with HW team" — so every review in the named track
       that is held with one of the other tracks is the group. Naming the
       counterpart tracks is what keeps this from swallowing the self-reviews
       and the checklist reviews that are internal to the track. */
    const owner = cv.trackKeys[0] && TRACK_CATEGORY[cv.trackKeys[0]];
    const others = cv.trackKeys.slice(1).filter((k) => TRACK_CATEGORY[k]);
    const withOther = new RegExp(`\\bwith\\b.*\\b(${["HW", "hardware", "FW", "firmware", "enclosure", "ENC"].join("|")})\\b`, "i");
    const pool = steps.filter((s) => s.category === owner && withOther.test(s.step));
    const words = cv.name.toLowerCase().match(/[a-z]{3,}/g) || [];
    const topic = words.filter((w) => !["review", "reviews", "with", "team", "the", "and"].includes(w));
    const hit = pool.filter((s) => topic.some((w) => s.step.toLowerCase().includes(w)));
    cv.steps = (hit.length ? hit : pool).map((s) => s.no);
    cv.matchedLoosely = true;
    if (!cv.steps.length) blockNotes.push(`convergence ${cv.n} "${cv.name}" matches no step in the workbook`);
    else if (others.length) { /* the group is real */ }
  }
  /* The mirror. A convergence is drawn once, in the track that calls the
     meeting — "Block diagram review with FW & Enclosure team" sits in
     hardware. The other tracks hold their own side of the same meeting under
     their own name ("Block diagram review with HW"), and finding it is what
     turns a note in a spreadsheet into a dependency the schedule can enforce.

     A mirror has to be a review held WITH another track and be about the same
     thing. Both halves matter: without the first it picks up the track's own
     self-reviews, without the second it picks up any cross-track review at
     all. Where no mirror exists, none is invented — that track is listed as
     having nothing to hold to the barrier. */
  {
    const topicWords = (cv.name.toLowerCase().match(/[a-z]{3,}/g) || [])
      .filter((w) => !["review", "reviews", "with", "team", "the", "and", "file"].includes(w));
    const crossTrack = /\bwith\b[^,]*\b(hw|hardware|fw|firmware|enclosure|enc)\b/i;
    const owned = new Set(cv.steps);
    for (const k of cv.trackKeys) {
      const cat = TRACK_CATEGORY[k];
      if (!cat || cv.steps.some((no) => steps.find((s) => s.no === no)?.category === cat)) continue;
      const mirror = steps.find((s) =>
        s.category === cat && !owned.has(s.no) && crossTrack.test(s.step) &&
        topicWords.filter((w) => s.step.toLowerCase().includes(w)).length >= Math.min(2, topicWords.length));
      if (mirror) { cv.steps.push(mirror.no); owned.add(mirror.no); (cv.mirrors ||= []).push(mirror.no); }
    }
  }

  cv.stepsByTrack = {};
  for (const no of cv.steps) {
    const s = steps.find((x) => x.no === no);
    const key = Object.keys(TRACK_CATEGORY).find((k) => TRACK_CATEGORY[k] === s?.category) || "OTHER";
    (cv.stepsByTrack[key] ||= []).push(no);
  }
  /* A named track with nothing in it cannot be held to the barrier. Say so —
     this is a gap in the workbook, and it is exactly the kind of gap that only
     shows up as a surprise in week nine. */
  cv.tracksWithoutAStep = cv.merge ? [] : cv.trackKeys.filter((k) => TRACK_CATEGORY[k] && !cv.stepsByTrack[k]?.length);
}

/* ── the waves ───────────────────────────────────────────────────────────────
   EbODM_Process_Flow.pdf carries what the workbook cannot: the DEPENDENCY
   graph. Steps are grouped into waves (P01, H07, F14 …); a wave holds steps
   with no dependency on each other, so everything in it starts together, and
   the wave order inside a track is fixed. Hardware, firmware and enclosure all
   begin after the last pre-design wave and the test merge waits on all three —
   "pulling in Firmware alone does not move the merge", as the diagram says.

   Without this a plan can only spread steps evenly and pretend that is a
   schedule. With it there is a real critical path.

   The PDF lays the three tracks out in side-by-side columns, so extracted step
   names arrive truncated ("Enclosure Features Che"). The workbook holds the
   authoritative names, so every wave entry is matched back to a real step by
   prefix — the wave file supplies ORDER, the workbook supplies identity.     */
let waves = [];
let map_waveByName = {};
if (flowText) {
  const raw = (await import("node:fs")).readFileSync(flowText, "utf8");
  const TRACKS = [
    [/^Pre-design feasibility$/i, "P", "1 · Pre-design Feasibility"],
    [/^Hardware$/i, "H", "2 · Design — Hardware"],
    [/^Firmware$/i, "F", "2 · Design — Firmware"],
    [/^Enclosure$/i, "E", "2 · Design — Enclosure"],
    [/^Prototype$/i, "R", "4 · Prototype"],
    [/^Pilot$/i, "L", "5 · Pilot"],
    [/^Mass production$/i, "M", "6 · Mass Production"],
  ];
  const prefixTrack = { P: TRACKS[0][2], H: TRACKS[1][2], F: TRACKS[2][2], E: TRACKS[3][2],
                        R: TRACKS[4][2], L: TRACKS[5][2], M: TRACKS[6][2] };

  const lines = raw.split("\n").map((l) => l.trim());
  const byId = new Map();
  let cur = null;
  for (const line of lines) {
    const id = /^([PHFERLM])(\d{2})$/.exec(line);
    if (id) {
      const key = line;
      if (!byId.has(key)) byId.set(key, { id: key, track: id[1], order: Number(id[2]), names: [] });
      cur = byId.get(key);
      continue;
    }
    // A block boundary ends the current wave. The diagram's side-by-side
    // columns overflow into blocks of their own ("nclosure", "ecklist",
    // "Dimensioning") — wrapped tails of names already read. Without this
    // reset they attach to whichever wave came last and push that whole track
    // out of step. A genuine continuation always restates its wave ID.
    if (/^──────/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    // "4 in parallel" is a count, not a step; so are the page-furniture lines.
    if (/^\d+\s*(in parallel|illl)$/i.test(line) || !line || /^(Page|Elecbits)/.test(line)) continue;
    if (TRACKS.some(([re]) => re.test(line))) { cur = null; continue; }
    cur.names.push(line);
  }

  /* Match each wave's step names back to the workbook.

     Both documents list a track's steps in the same order, so the matching is
     SEQUENTIAL with the name as confirmation rather than as the key. That
     matters because the diagram lays the three design tracks out in
     side-by-side columns and the extracted enclosure names arrive both
     truncated and split ("Enclosure Features Che" … "cklist"): a name-only
     match loses a third of that track, while order plus a prefix check keeps
     it and still catches a genuine mis-alignment. */
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // A wrapped column tail is not a step name: it starts mid-word or is tiny.
  const looksLikeAStep = (n) => n.length >= 8 && /^[A-Z0-9]/.test(n);

  let matched = 0, confirmed = 0, missed = [];
  const cursor = {};
  const used = new Set();
  for (const w of [...byId.values()].sort((a, b) => a.track.localeCompare(b.track) || a.order - b.order)) {
    const category = prefixTrack[w.track];
    /* The workbook interleaves "Audit Checklist update — …" steps that the
       diagram never draws. Left in the sequence they consume a position each
       and push the whole track out of step, so they are held back and placed
       by number afterwards, next to the work they audit. */
    const pool = steps.filter((s) => s.category === category && !/^Audit Checklist/i.test(s.step));
    cursor[category] = cursor[category] ?? 0;
    const stepNos = [];
    /* A wave that spills across a page is drawn twice, so its steps arrive
       twice — once clipped ("ReferenceProductIdentification") and once whole.
       Both normalise to the same thing, and left alone the first copy eats the
       step and the second takes its neighbour, sliding the rest of the track
       along by one. */
    const seen = new Set();
    for (const name of w.names) {
      if (!looksLikeAStep(name)) continue;
      const key = norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const n = norm(name);
      // The cursor is the first step of this track nobody has taken yet, not a
      // running count — so looking ahead to resolve a transposition leaves the
      // step it stepped over still available for the next name.
      while (cursor[category] < pool.length && used.has(pool[cursor[category]].no)) cursor[category]++;
      const at = cursor[category];
      if (at >= pool.length) { missed.push(`${w.id}: ${name.slice(0, 40)} (past the end of ${category})`); continue; }
      const agreesWith = (st) => st && (norm(st.step).startsWith(n) || n.startsWith(norm(st.step)));
      /* Look a little way ahead. The two documents transpose the odd pair —
         the workbook has "Schematic review with FW & Enclosure" before "New
         Component Registration" and the diagram has them the other way round.
         Without a window the cursor slips and every step after it is wrong;
         with one, the pair swaps back and the track stays aligned. */
      /* Search FORWARD from the cursor for a step whose name agrees, not just
         the next few. The workbook carries steps the diagram never draws, so
         the gap between two consecutive drawn steps can be several rows wide.
         Searching forward only — never backward — keeps the track in order,
         and the name check is what stops a far match from being a wrong one. */
      let pick = at;
      for (let k = at; k < pool.length; k++) {
        if (used.has(pool[k].no)) continue;
        if (agreesWith(pool[k])) { pick = k; break; }
      }
      const next = pool[pick];
      const agrees = agreesWith(next);
      if (agrees) confirmed++;
      else missed.push(`${w.id}: "${name.slice(0, 34)}" ≠ "${next.step.slice(0, 34)}"`);
      used.add(next.no); stepNos.push(next.no); matched++;
      if (pick === at) cursor[category] = at + 1;
    }
    waves.push({ id: w.id, track: w.track, order: w.order, category, steps: stepNos });
  }
  waves = waves.filter((w) => w.steps.length);

  // Predecessors: the next wave in a track waits on the one before it; the
  // three design tracks all wait on the end of pre-design; the merge waits on
  // all three; and the serial tail runs one phase after another.
  const last = (t) => waves.filter((w) => w.track === t).at(-1)?.id;
  const firstOf = (t) => waves.filter((w) => w.track === t)[0]?.id;
  for (const w of waves) {
    const prev = waves.filter((x) => x.track === w.track && x.order < w.order).at(-1);
    w.after = prev ? [prev.id] : [];
  }
  for (const t of ["H", "F", "E"]) {
    const f = waves.find((w) => w.id === firstOf(t));
    if (f && last("P")) f.after = [last("P")];
  }
  const rFirst = waves.find((w) => w.id === firstOf("R"));
  if (rFirst) rFirst.after = ["H", "F", "E"].map(last).filter(Boolean);
  const lFirst = waves.find((w) => w.id === firstOf("L"));
  if (lFirst && last("R")) lFirst.after = [last("R")];
  const mFirst = waves.find((w) => w.id === firstOf("M"));
  if (mFirst && last("L")) mFirst.after = [last("L")];

  /* Test and DFx steps are in the workbook but not drawn as waves — the
     diagram runs test "per track, inline" and DFx "interleaved by gate". They
     join the wave of the nearest step BY NUMBER, whatever its category, which
     is exactly what inline means: the test of a routing step sits with that
     routing step, not at the end of the project. */
  const waveOfStep = new Map();
  for (const w of waves) for (const no of w.steps) waveOfStep.set(no, w.id);
  const waved = steps.filter((x) => waveOfStep.has(x.no));
  for (const s of steps) {
    if (waveOfStep.has(s.no)) continue;
    const near = waved.reduce((best, x) =>
      Math.abs(x.no - s.no) < Math.abs(best.no - s.no) ? x : best, waved[0]);
    const w = near && waves.find((x) => x.id === waveOfStep.get(near.no));
    if (w) { w.steps.push(s.no); waveOfStep.set(s.no, w.id); }
  }
  for (const s of steps) s.wave = waveOfStep.get(s.no) || "";

  /* ── the convergence points become real dependencies ───────────────────────
     Two tracks that must agree at a review cannot be scheduled as if they will
     happen to arrive on the same day. Each side of the meeting waits on the
     wave BEFORE the other side's — not on the other side itself, which would
     be a deadlock — so neither track can run past the meeting until the other
     has done the work it is bringing to it.

     Only convergences with a step in two or more tracks can be enforced. The
     rest are carried as declarations the UI shows on the step, and the tracks
     with nothing to hold are named in the build output.                      */
  let enforced = 0;
  const waveIndex = new Map(waves.map((w) => [w.id, w]));
  const priorWave = (id) => {
    const w = waveIndex.get(id);
    if (!w) return null;
    return waves.filter((x) => x.track === w.track && x.order < w.order).at(-1) || null;
  };
  for (const cv of convergence) {
    const ws = [...new Set(cv.steps.map((no) => waveOfStep.get(no)).filter(Boolean))];
    cv.waves = ws;
    if (cv.merge || ws.length < 2) continue;
    for (const a of ws) {
      for (const b of ws) {
        if (a === b) continue;
        const p = priorWave(b);
        const wa = waveIndex.get(a);
        if (p && wa && p.track !== wa.track && !wa.after.includes(p.id)) { wa.after.push(p.id); enforced++; }
      }
    }
    cv.enforced = true;
  }
  if (enforced) console.log(`convergence: ${enforced} cross-track dependency(ies) added to the wave graph`);

  /* Waves are keyed by step NAME as well as number. The workbook is edited in
     Drive — rows get inserted, reordered and removed — and a row number means
     nothing the moment somebody does that. A name survives an edit; a number
     silently points at the wrong step. */
  /* Keyed by CATEGORY and name, not name alone: "System Block Diagram" is the
     first step of both the hardware and the firmware track, and a name-only
     key silently merges the two into one wave — which then reshapes the
     schedule for every step after it. */
  map_waveByName = {};
  for (const s of steps) {
    if (s.wave) map_waveByName[`${norm(s.category)}|${norm(s.step)}`] = s.wave;
  }

  console.log(`waves: ${waves.length} · ${matched} steps placed · ${confirmed} names confirmed · ${missed.length} to check`);
  if (missed.length) for (const m of missed.slice(0, 8)) console.log(`    ? ${m}`);
  const orphan = steps.filter((s) => !s.wave).length;
  if (orphan) console.log(`    ! ${orphan} step(s) ended up in no wave`);
}

/* Which block each step belongs to, so a plan can be read the way the Flow Map
   draws it rather than as one flat list of 308 rows. A step whose category is
   split across two blocks (Test) takes the block whose source rows cover it. */
{
  const byCategory = {};
  for (const b of blocks) (byCategory[b.category] ||= []).push(b);
  const blockOf = new Map();
  for (const [cat, bs] of Object.entries(byCategory)) {
    const inCat = steps.filter((s) => s.category === cat).sort((a, b) => a.no - b.no);
    if (bs.length === 1) { for (const s of inCat) blockOf.set(s.no, bs[0].id); continue; }
    /* Test is drawn twice — 39 steps inline in the tracks, then 13 more after
       the merge — where the workbook keeps one category of 52. The sheet's own
       counts are what splits them, in the order the sheet lists the blocks, so
       nothing here has to guess which test is which. */
    let cursor = 0;
    for (const b of bs) {
      for (const s of inCat.slice(cursor, cursor + b.steps)) blockOf.set(s.no, b.id);
      cursor += b.steps;
      b.split = true;
    }
    for (const s of inCat.slice(cursor)) blockOf.set(s.no, bs.at(-1).id);
  }
  for (const s of steps) s.block = blockOf.get(s.no) || "";
}
// Steps that ARE a convergence point, so the work window can say who else has
// to be in the room before the step can be closed.
{
  const at = new Map();
  for (const cv of convergence) for (const no of cv.steps) at.set(no, cv);
  for (const s of steps) {
    const cv = at.get(s.no);
    if (cv) s.converge = { n: cv.n, name: cv.name, tracks: cv.tracks, agree: cv.agree, merge: !!cv.merge };
  }
}

const map = {
  waves,
  waveByName: map_waveByName,
  source: path.basename(src),
  templateSource: indexSrc ? path.basename(indexSrc) : "",
  builtBy: "scripts/build-process-map.mjs",
  stepCount: steps.length,
  categories,
  blocks,
  convergence,
  flowMap: { title: flowTitle, total: declaredTotal, unread },
  templates,
  steps,
};

await writeFile(OUT, JSON.stringify(map, null, 1) + "\n");

const bytes = (await import("node:fs")).statSync(OUT).size;
console.log(`${steps.length} steps · ${categories.length} categories · ${Object.keys(templates).length} templates`);
console.log(`${(bytes / 1024).toFixed(0)} KB → ${OUT}`);
for (const n of templateNotes) console.log(`  · ${n}`);

/* The block sequence, printed the way the Flow Map draws it. This is the thing
   to read after a change to the sheet: if a block is in the wrong group or a
   row went missing, it shows up here before it shows up in somebody's plan. */
console.log(`\n  THE MAJOR BLOCKS, IN SEQUENCE`);
let group = "";
for (const b of blocks) {
  if (b.group !== group) {
    group = b.group;
    const kinds = [...new Set(blocks.filter((x) => x.group === group).map((x) => x.kind))].join(" + ");
    console.log(`  ${group} — ${kinds}`);
  }
  console.log(`      ${b.id.padEnd(3)} ${b.name.padEnd(34)} ${String(b.steps).padStart(3)} steps   ${b.runs}`);
  if (b.convergesWith) console.log(`          ↳ ${b.convergesWith}`);
}
console.log(`      ${"".padEnd(3)} ${"TOTAL".padEnd(34)} ${String(blocks.reduce((s, b) => s + b.steps, 0)).padStart(3)} steps`);

if (convergence.length) {
  console.log(`\n  CROSS-TRACK CONVERGENCE POINTS`);
  for (const cv of convergence) {
    const where = cv.steps.length ? `step${cv.steps.length > 1 ? "s" : ""} ${cv.steps.join(", ")}` : "no step found";
    console.log(`      ${cv.n}. ${cv.name}`);
    console.log(`         ${cv.tracks} · ${where}${cv.enforced ? " · enforced in the schedule" : ""}`);
    if (cv.tracksWithoutAStep?.length)
      console.log(`         ! the sheet says ${cv.tracksWithoutAStep.join(" and ")} must be here, but ${cv.tracksWithoutAStep.length > 1 ? "those tracks have" : "that track has"} no step for it — nothing holds them to it`);
  }
}

if (blockNotes.length) {
  console.log(`\n  ! the Flow Map and the Process Flow tab do not line up:`);
  for (const n of blockNotes) console.log(`      ${n}`);
}
if (unread.length) {
  console.log(`\n  ! ${unread.length} Flow Map row(s) the reader did not understand — nothing is dropped silently, so check these:`);
  for (const u of unread) console.log(`      ${u}`);
}

console.log("");
for (const c of categories) {
  console.log(`  ${String(c.count).padStart(3)}  ${c.name}${c.parallel ? "  (concurrent)" : ""}${c.gated ? "  (gated)" : ""}`);
}
/* A step whose template is not in the Template Actions tab has no folder, so
   nothing can say where its file belongs. That is a gap in the workbook, not
   in the code, and it has to be shouted about rather than papered over — a
   confidently wrong Drive path is worse than an admitted blank. */
{
  const glued = steps.filter((s) => /^EB-T-\d+\s*[·|:-]/.test(clean(flow.find((r) => Number(clean(r[COL.no])) === s.no)?.[COL.templateFile] || "")));
  if (glued.length) console.log(`\n  · ${glued.length} step(s) in the workbook have the template id glued onto the filename — stripped here, but worth fixing in Drive (steps ${glued.slice(0, 6).map((s) => s.no).join(", ")}${glued.length > 6 ? " …" : ""})`);
}
/* A template whose blank lives in one tree and whose filled-in copy is said to
   live in a completely different one is almost always a copy-paste in the
   register — and it sends somebody's work to the wrong half of the project. */
{
  /* Compared without the leading numbers: the register writes the same folder
     as "06-Assembly" in one column and "05-Assembly" in the other, and a
     literal comparison would report two dozen renumberings as if they were
     misfiled templates. Noise like that gets the whole report ignored. */
  const top = (p) => (String(p || "").split("/").filter(Boolean)[0] || "").replace(/^\d+[-.]?\s*/, "").toLowerCase();
  const strip = (p) => String(p || "").replace(/^0[12]-(Project-ID-Folder-PM|PCB-ID-Folder-Engineering)\//, "");
  const odd = Object.values(templates).filter((t) => t.library && t.folder &&
    top(strip(t.library)) && top(t.folder) && top(strip(t.library)) !== top(t.folder));
  if (odd.length) {
    console.log(`\n  ! ${odd.length} template(s) whose blank and whose filled-in copy are in different parts of the project — check these in the index:`);
    for (const t of odd.slice(0, 8)) console.log(`      ${t.id} ${t.name}\n          blank: ${t.library}\n          copy:  ${t.folder}`);
  }
}
const orphanTemplates = [...new Set(steps.filter((s) => !templates[s.templateId]).map((s) => s.templateId))];
if (orphanTemplates.length) {
  console.log(`\n  ! ${orphanTemplates.length} template(s) used by steps but MISSING from the Template Actions tab:`);
  for (const id of orphanTemplates) {
    const using = steps.filter((s) => s.templateId === id);
    console.log(`      ${id} — used by step(s) ${using.map((s) => s.no).join(", ")}: ${using[0].template}`);
    console.log(`      no folder is known for it, so those steps cannot say where their file goes.`);
  }
  console.log(`      Fix in Drive: add a row per id to the Template Actions tab with its folder.`);
}
