# The process documents

These five files are the source of truth for how a project runs.
`src/data/process-map.json` is generated from them — the app never reads these
directly, and nothing here should be edited by hand to change app behaviour.
Change the document, then regenerate.

## Regenerating after a change

```bash
node scripts/pdf-text.mjs docs/process/EbODM_Process_Flow_waves.pdf /tmp/flow.txt
node scripts/build-process-map.mjs \
  docs/process/EbODM_Master_Process_Flow_v6.xlsx \
  /tmp/flow.txt \
  docs/process/EbODM_TemplateIndex.xlsx
```

Arguments are taken by kind, not by position — the workbook with a **Process
Flow** tab is the master, the one with an **Index** tab is the template
register, the `.txt` is the waves — so they cannot be handed over the wrong way
round.

The build prints what it did and, more usefully, what it could not confirm.

**The block sequence.** This is the thing to read after editing the Flow Map:

```
  THE MAJOR BLOCKS, IN SEQUENCE
  A — Serial
      A1  Pre-design Feasibility              35 steps   Sequential (entry: PO received)
  B — Parallel + Gate
      B1  Design — Hardware                   71 steps   Concurrent track 1
      …
          TOTAL                              308 steps
```

If a block is in the wrong group, a count is wrong or a row went missing, it
shows up here before it shows up in somebody's plan. Any Flow Map row the
reader cannot place is listed under `Flow Map row(s) the reader did not
understand` rather than being dropped.

**The convergence points.** The Flow Map's second section names the places the
three parallel tracks must stop and agree. Where both sides of a meeting exist
in the workbook they become real dependencies in the wave graph; where they do
not, the build says so:

```
      2. Schematic review with FW & Enclosure team
         HW ↔ FW ↔ ENC · step 57
         ! the sheet says FW and ENC must be here, but those tracks have no
           step for it — nothing holds them to it
```

That is a gap in the workbook. It is the kind that only surfaces as a surprise
in week nine, so it is printed every build until somebody adds the step.

**The wave check.**

```
waves: 147 · 220 steps placed · 219 names confirmed · 1 to check
    ? H32: "Iterations if required" ≠ "DRC Rules Setup"
```

It means the workbook and the diagram disagree about the order of a step. One
of the two documents is wrong; the build takes the diagram's order and says so
rather than hiding it.

**The template checks.** Templates a step uses that nothing defines, folders
the two documents disagree about, ids that resolve to two files in Drive, and
templates whose blank and whose filled-in copy are said to live in different
parts of the project — all printed, none guessed at. A confidently wrong Drive
path gets obeyed; an admitted blank does not.

## What each one carries

| File | What only this one knows |
|---|---|
| `EbODM_Master_Process_Flow_v6.xlsx` | What each of the 308 steps IS — entry and exit triggers, the gate questions, the template it writes to, the responsible function, and how to actually do it. Its **Flow Map** tab names the ten major blocks, fixes their sequence, and names the cross-track convergence points |
| `EbODM_TemplateIndex.xlsx` | The template register: all 178 templates, the exact folder the filled-in copy goes in, what it is called, what good looks like, and a link straight to the blank in Drive |
| `EbODM_Process_Flow_waves.pdf` | What waits on what. Steps grouped into waves (P01, H07, F14 …) with fixed predecessors. Without this a plan can only spread steps evenly and pretend that is a schedule |
| `Elecbits_Project_Management_Sitemap_v2_1.pdf` | Where PM-side artefacts live, and the folders the process has no home for today |
| `Elecbits_PCB_ID_Sitemap_v2_1.pdf` | Where engineering artefacts live, the Rev-0…N revision model, and the G0–G3 DFx gates |

## Rules from the documents that the code depends on

**The Flow Map defines the blocks and their order.** Ten blocks in three
groups: A runs alone, B splits into three concurrent design tracks with test
inline and the DFx gates across them, C runs serially after the merge. Every
one of the 308 steps belongs to exactly one block, and the block counts on the
sheet are what split a category drawn twice — Test appears as 39 steps inline
and 13 more after the merge, where the workbook keeps one category of 52.

**The design tracks run concurrently.** Hardware is 39 waves deep, firmware 23,
enclosure 33. They all start after the last pre-design wave, and the prototype
merge waits on all three — *"pulling in Firmware alone does not move the
merge."* Laying them end to end would invent months of calendar that do not
exist.

**Convergence is a dependency, not a note.** Two tracks that must agree at a
review cannot be scheduled as if they will happen to arrive on the same day.
Each side of the meeting waits on the wave *before* the other side's — never on
the other side itself, which would deadlock — so neither track can run past the
meeting until the other has done the work it is bringing to it.

**A revision is a set, never a file.** Gerber, ODB, Netlist, Step, Schematic
PDF, 3D PDF, Project Files, BOM and Pick-and-Place move together. A released
revision is immutable; a change creates Rev-N+1. `CURRENT-REVISION.txt` names
the live one.

**A folder name is not free-form.** `Project Folder - R&D PM`, `- R&D` and
`Project File - R&D` are the same folder under three names across 122
projects, which is why conformance reads lower than it truly is. The app
matches folders by stem for exactly this reason, but new folders it creates
use the sitemap spelling.
