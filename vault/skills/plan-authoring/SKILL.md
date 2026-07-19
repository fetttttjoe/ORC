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
3. Call `ask_human("Plan ready — reply with changes, or 'approve' to start.")`. On changes, read the
   queued annotations (each `plan_annotated` names a `targetNote`) and revise **ONLY those notes and
   their `decomposes_into` subtree** — re-`memory_write` just the affected notes, leave every other
   note byte-stable (targeted + token-cheap on large plans; this is the mechanical D6 guarantee). Ask
   again. Loop until the reply is `approve`.
4. On `approve`, call `finalize_plan()` — it deterministically translates the plan-note graph into the
   executable plan and `task_split`s it. Then signal success. Do NOT hand-build the split:
   `finalize_plan` derives it from the notes, so the executable plan can never drift from what the
   human approved.
