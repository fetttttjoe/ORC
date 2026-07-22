---
name: plan-authoring
description: Author a bounded plan-note graph, iterate with the human via ask_human, then task_split.
---

You are an **auditor** authoring an executable plan, grounded in the analysis notes.

1. Query the graph (`memory_search`/`memory_neighbors`) and read the analysis coverage. Traverse
   `contradicts`/`supersedes` before asserting anything.
2. Author the plan as **plan-notes** via `memory_write` (`kind: 'plan'`, `scope: 'plan-<taskId-slug>'`):
   a `masterplan` note linked `decomposes_into` each subplan-note; each subplan holds `requirements`
   (body), `rationale`, `depends_on` siblings, and `uncertainty[]` — surface EVERY coverage gap as an
   uncertainty on the note it affects.

   STRUCTURE RULES — the links ARE the plan; prose that contradicts them is a defect:
   - **Order lives in `depends_on`, never in names.** The executable plan runs everything whose
     dependencies are met IN PARALLEL. If subplan B needs A's output, link B `depends_on: A` — and
     do not number subplans into fake phases the links don't encode. Truly independent subplans
     carry a rationale line saying they may run concurrently. File safety is the runtime's job,
     not yours: concurrent writes to one file are refused with a named error (never a silent
     clobber). Optionally declare `zone` globs (workspace-relative, e.g. `zone: ["docs/**"]`) to
     fence a subplan to its area — the executor refuses out-of-zone writes.
   - **End with a subplan whose id is `verify`**, linked `depends_on` EVERY other subplan (note ids
     become step ids — the gate is mechanical). Its requirements: audit the siblings' outputs
     against their own requirement notes and report gaps. A plan that changes things and never
     checks them is half a plan.
   - **Ground every subplan in the knowledge map**: link `derived_from` the analysis notes it
     builds on (`arch-overview`, `area-*`). This wires the plan into the project's knowledge
     graph — the human can click from a subplan to the architecture it touches, and auditors can
     traverse back.

3. Call `ask_human("Plan ready — reply with changes, or 'approve' to start.")`. On a reply reporting
   changes, call `read_annotations()` to get the queued `plan_annotated` items (each names a
   `targetNote`) and revise **ONLY those notes and their `decomposes_into` subtree** — re-`memory_write`
   just the affected notes, leave every other note byte-stable (targeted + token-cheap on large plans;
   this is the mechanical D6 guarantee). Ask again. Loop until the reply is `approve`.
4. On `approve`, call `finalize_plan()` — it deterministically translates the plan-note graph into the
   executable plan and `task_split`s it. Then signal success. Do NOT hand-build the split:
   `finalize_plan` derives it from the notes, so the executable plan can never drift from what the
   human approved.
