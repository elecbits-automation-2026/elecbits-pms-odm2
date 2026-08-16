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

function adopt(map) {
  MAP = applyWaves(deriveCategories(map));
  STEPS = MAP.steps;
  CATEGORIES = MAP.categories;
  TEMPLATES = MAP.templates;
  WAVES = MAP.waves || [];
  return MAP;
}

/* ── loading it from Drive ───────────────────────────────────────────────────
   Once per session, or on demand when somebody has just edited the workbook.
   The cache is what makes an offline Drive survivable without pretending: the
   data is used, and SOURCE says it is a cached copy and how old it is.       */
const CACHE_KEY = "eb-process-map-v1";

function fromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c?.map?.steps?.length ? c : null;
  } catch { return null; }
}

export async function loadProcessMap(readDrive, { force = false } = {}) {
  if (!force && SOURCE.from === "drive") return MAP;

  // A cached copy first, so the app is usable in the second before Drive
  // answers — then replaced the moment the live one arrives.
  const cached = fromCache();
  if (cached && SOURCE.from === "bundled") {
    adopt(cached.map);
    Object.assign(SOURCE, cached.source, { from: "cache" });
  }

  if (typeof readDrive !== "function") return MAP;
  try {
    const r = await readDrive({ action: "process_map" });
    if (r?.error) throw new Error(r.error);
    if (!r?.steps?.length) throw new Error("Drive returned a workbook with no steps in it.");

    adopt({ steps: r.steps, templates: r.templates || {}, blocks: r.blocks || [] });
    Object.assign(SOURCE, {
      from: "drive", error: "",
      fileName: r.file?.name || "", path: r.file?.path || "",
      editLink: r.file?.editLink || "", modifiedTime: r.file?.modifiedTime || "",
      fetchedAt: new Date().toISOString(),
      alternates: r.alternates || [],
    });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        map: { steps: r.steps, templates: r.templates || {}, blocks: r.blocks || [] },
        source: { ...SOURCE },
      }));
    } catch { /* a full quota is not a reason to fail the load */ }
  } catch (e) {
    // Say which copy is being used and why the live one is not — never fall
    // back silently, because a stale plan is indistinguishable from a current
    // one until somebody works to the wrong method.
    SOURCE.error = String(e?.message || e);
    if (SOURCE.from !== "cache") SOURCE.from = "bundled";
  }
  return MAP;
}

/* One line for the UI: which method this plan is built from. */
export function sourceLine() {
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

export const stepByNo = (no) => STEPS.find((s) => s.no === Number(no)) || null;
export const stepsIn = (category) => STEPS.filter((s) => s.category === category);

/* ── where a step's file actually goes ───────────────────────────────────────
   The workbook writes filenames as [ProjectID]_Thing-Name and keeps the folder
   with the template. Together they are the exact address of the artefact the
   step must produce — which is what lets somebody do the work without opening
   Drive to hunt for the right folder first.                                  */
export const fileNameFor = (step, projectId) =>
  String(step?.templateFile || "").replace(/\[ProjectID\]/g, projectId || "[ProjectID]");

export const folderFor = (step) => TEMPLATES[step?.templateId]?.folder || "";

/* The full path, given the project's own root folder (which the app already
   knows as pmPath(projectId)). Kept as one function so a path never gets
   assembled two different ways in two different screens. */
export function pathFor(step, projectId, projectRoot = "") {
  const folder = folderFor(step);
  const root = String(projectRoot || "").replace(/\/+$/, "");
  return `${root}/${folder}${fileNameFor(step, projectId)}`.replace(/\/{2,}/g, "/");
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

  const steps = only ? STEPS.filter((s) => only.has(s.category)) : STEPS;
  const categories = only ? CATEGORIES.filter((c) => only.has(c.name)) : CATEGORIES;
  const when = scheduleSteps({ start, end, milestones: opts.milestones || [], steps, categories });

  return steps.map((s) => {
    const w = when.get(s.no) || {};
    return {
      no: s.no,
      category: s.category,
      phase: w.phase,
      title: s.step,
      action: s.action,
      template: s.template,
      templateId: s.templateId,
      fileName: fileNameFor(s, projectId),
      folder: folderFor(s),
      path: pathFor(s, projectId, opts.projectRoot || ""),
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
