# The process documents

These four files are the source of truth for how a project runs. `src/data/process-map.json`
is generated from them — the app never reads these directly, and nothing here
should be edited by hand to change app behaviour. Change the document, then
regenerate.

## Regenerating after a change

```bash
node scripts/pdf-text.mjs docs/process/EbODM_Process_Flow_waves.pdf /tmp/flow.txt
node scripts/build-process-map.mjs docs/process/EbODM_Master_Process_Flow_v6.xlsx /tmp/flow.txt
```

The build prints what it did and, more usefully, what it could not confirm:

```
waves: 147 · 220 steps placed · 219 names confirmed · 1 to check
    ? H32: "Iterations if required" ≠ "DRC Rules Setup"
```

**Read that line.** It means the workbook and the diagram disagree about the
order of a step. One of the two documents is wrong; the build takes the
diagram's order and says so rather than hiding it.

The build also reports any template a step uses that the **Template Actions**
tab does not define:

```
! 1 template(s) used by steps but MISSING from the Template Actions tab:
    EB-T-161 — used by step(s) 7, 17, 18, 19: [ProjectID]_LLD-Developer_v1.0
```

Those steps have no folder, so nothing can say where their file belongs. The
app admits that rather than inventing a path — a confidently wrong Drive path
gets obeyed. Fix it by adding a row for the id to the Template Actions tab.

## What each one carries

| File | What only this one knows |
|---|---|
| `EbODM_Master_Process_Flow_v6.xlsx` | What each of the 308 steps IS — entry and exit triggers, the gate questions, the template it writes to, the responsible function, and how to actually do it |
| `EbODM_Process_Flow_waves.pdf` | What waits on what. Steps grouped into waves (P01, H07, F14 …) with fixed predecessors. Without this a plan can only spread steps evenly and pretend that is a schedule |
| `Elecbits_Project_Management_Sitemap_v2_1.pdf` | Where PM-side artefacts live, and the five folders the 305-step process has no home for today |
| `Elecbits_PCB_ID_Sitemap_v2_1.pdf` | Where engineering artefacts live, the Rev-0…N revision model, and the G0–G3 DFx gates |

## Three rules from the documents that the code depends on

**The design tracks run concurrently.** Hardware is 39 waves deep, firmware 23,
enclosure 33. They all start after the last pre-design wave, and the prototype
merge waits on all three — *"pulling in Firmware alone does not move the
merge."* Laying them end to end would invent months of calendar that do not
exist.

**A revision is a set, never a file.** Gerber, ODB, Netlist, Step, Schematic
PDF, 3D PDF, Project Files, BOM and Pick-and-Place move together. A released
revision is immutable; a change creates Rev-N+1. `CURRENT-REVISION.txt` names
the live one.

**A folder name is not free-form.** `Project Folder - R&D PM`, `- R&D` and
`Project File - R&D` are the same folder under three names across 122
projects, which is why conformance reads lower than it truly is. The app
matches folders by stem for exactly this reason, but new folders it creates
use the sitemap spelling.
