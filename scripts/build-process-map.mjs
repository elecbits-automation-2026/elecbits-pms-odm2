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

const map = {
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
