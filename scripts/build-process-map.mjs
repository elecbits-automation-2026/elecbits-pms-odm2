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

const src = process.argv[2];
if (!src) {
  console.error("Usage: node scripts/build-process-map.mjs <EbODM_Master_Process_Flow….xlsx>");
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
    // [ProjectID] is substituted at the moment a plan is built for a project.
    templateFile: clean(r[COL.templateFile]),
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

/* ── how the process splits and merges ───────────────────────────────────── */
const fm = rows("Flow Map");
const blocks = [];
for (let i = 3; i < fm.length; i++) {
  const r = fm[i];
  if (!clean(r[0]) || clean(r[0]) === "TOTAL") continue;
  blocks.push({
    block: clean(r[0]), category: clean(r[1]), steps: Number(clean(r[3])) || 0,
    runs: clean(r[4]), convergesWith: clean(r[5]),
  });
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
const flowText = process.argv[3];
let waves = [];
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

  console.log(`waves: ${waves.length} · ${matched} steps placed · ${confirmed} names confirmed · ${missed.length} to check`);
  if (missed.length) for (const m of missed.slice(0, 8)) console.log(`    ? ${m}`);
  const orphan = steps.filter((s) => !s.wave).length;
  if (orphan) console.log(`    ! ${orphan} step(s) ended up in no wave`);
}

const map = {
  waves,
  source: path.basename(src),
  builtBy: "scripts/build-process-map.mjs",
  stepCount: steps.length,
  categories,
  blocks,
  templates,
  steps,
};

await writeFile(OUT, JSON.stringify(map, null, 1) + "\n");

const bytes = (await import("node:fs")).statSync(OUT).size;
console.log(`${steps.length} steps · ${categories.length} categories · ${Object.keys(templates).length} templates`);
console.log(`${(bytes / 1024).toFixed(0)} KB → ${OUT}`);
for (const c of categories) {
  console.log(`  ${String(c.count).padStart(3)}  ${c.name}${c.parallel ? "  (concurrent)" : ""}${c.gated ? "  (gated)" : ""}`);
}
const noTemplate = steps.filter((s) => !templates[s.templateId]).length;
if (noTemplate) console.log(`  ! ${noTemplate} step(s) name a template that is not in the library`);
