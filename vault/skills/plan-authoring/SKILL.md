---
name: plan-authoring
description: Author a bounded plan-note graph, iterate with the human via ask_human, then task_split.
---

You are an **auditor** authoring an executable plan, grounded in the analysis notes.

1. Query the graph (`memory_search`/`memory_neighbors`) and read the analysis coverage. Traverse
   `contradicts`/`supersedes` before asserting anything.
2. Author the plan as **plan-notes** via `memory_write` (`tier: 'plan'`, `scope: 'plan-<taskId-slug>'`):
   a `masterplan` note linked `decomposes_into` each subplan-note; each subplan holds `requirements`
   (body), `rationale`, a `dependsOn` list of sibling ids, and `uncertainty[]` — surface EVERY
   coverage gap as an uncertainty on the note it affects.

   STRUCTURE RULES — this structure IS the plan; prose that contradicts it is a defect:
   - **Order lives in the `dependsOn` FIELD, never in names and never in links.** `dependsOn` takes
     sibling note ids: `dependsOn: ["a", "b"]`. It is a field rather than a `depends_on` link
     because a link is a durable statement about how FACTS relate, and ordering stops meaning
     anything the moment the plan is frozen into steps — keeping the two apart is what lets the
     knowledge graph stay about knowledge. A `depends_on` LINK on a plan-note is knowledge
     ("this subplan builds on that finding") and never affects scheduling.
     The executable plan runs everything whose dependencies are met IN PARALLEL. If subplan B needs
     A's output, set B `dependsOn: ["a"]` — and do not number subplans into fake phases the
     structure does not encode. Truly independent subplans
     carry a rationale line saying they may run concurrently. File safety is the runtime's job,
     not yours: concurrent writes to one file are refused with a named error (never a silent
     clobber). Optionally declare `zone` globs (workspace-relative, e.g. `zone: ["docs/**"]`) to
     fence a subplan to its area — the executor refuses out-of-zone writes.
   - **End with a subplan whose id is `verify`**, with `dependsOn` listing EVERY other subplan (note
     ids become step ids — the gate is mechanical). Its requirements: audit the siblings' outputs
     against their own requirement notes and report gaps. A plan that changes things and never
     checks them is half a plan.
   - **Give each subplan the capabilities it needs.** A subplan's step gets ONLY what its note
     declares: `toolRefs` for MCP tools (`web/search`, `web/fetch` — check what the project
     declares before naming one) and `skillRefs` for skills (`web-research`, `documentation`). A
     subplan that must look something up on the web and declares no `toolRefs` will fail, having no
     way to search. Declare nothing for steps that only read and edit local files.
   - **Split along independence, never along process.** A subplan is a piece someone could build
     without waiting for anyone else — a separate file, a separate surface. `implement → test →
     verify` is not a decomposition, it is one piece of work cut into a queue: wave 1 holds a single
     subplan, nothing runs in parallel, and each extra step pays a fresh agent context to re-learn
     what the previous one already had loaded. If two subplans must write the same file, they are
     ONE subplan. If a change is small and sequential, it is ONE subplan — decomposing it costs more
     than it saves. Decompose when parts are genuinely independent, then add the wiring subplan that
     `dependsOn` them.
   - **A measuring subplan gates; a gate runs first.** When a subplan's rationale is "measure,
     then decide whether to build", every subplan whose work that decision could cancel MUST
     `dependsOn` the measuring subplan — never run beside it as a wave sibling. A gate that runs
     parallel to the build it gates decides nothing: the build has already happened when the
     answer arrives.
   - **Verify never uses a tool this task introduces.** A step-tool added by this task exists
     only in uncommitted code the running supervisor never loaded, so a verify instructed to
     call it fails with "unknown tool". Have verify test the new tool AS CODE — run its tests,
     read its wiring — never invoke it live.
   - **Every subplan states its check.** End each subplan's requirements with a success
     criterion the verify step can check mechanically, and name how: the test file to run, the
     command, or the exact observable (a passing test name beats "works correctly"). A criterion
     verify cannot check is a hope, not a requirement.
   - **Match the model to the work.** Your instructions list the models you may name, with their
     rates. Set `modelRef` per subplan from that list: a frontier model where the work is genuinely
     hard (cross-cutting refactors, ambiguous requirements, design judgement, anything touching many
     files), the cheapest capable model where it is mechanical (a web lookup, a doc edit, a rename,
     reading something back to check it). Omit `modelRef` to inherit the planning model. A uniform
     choice across every subplan means you did not decide — say why in the rationale if it is
     deliberate. The human sees your choice at the gate and can change it.
   - **Ground every subplan in the knowledge map**: link `derived_from` the analysis notes it
     builds on (`arch-overview`, `area-*`). This wires the plan into the project's knowledge
     graph — the human can click from a subplan to the architecture it touches, and auditors can
     traverse back.
   - **`zone` is a JSON array, one glob per entry.** `zone: ["a/**", "b.ts"]`, never
     `zone: ["a/**\nb.ts"]` — an entry with an embedded newline (or any control character) can
     match no real path, so the fence refuses every write and the step is bricked. The gate
     refuses such a plan; fix the entry, never work around the fence.
   - **Never instruct a step to rely on tool fields the running build does not return.** Skills
     hot-reload but tool builds do not: prose shipped in the SAME task that adds a tool field
     reaches agents whose tools predate it. If a subplan's instructions depend on a new tool
     capability this task introduces, say so explicitly ("the running build may not return X —
     fall back to Y").

   - **A note describing the work is not the work.** On a project you have planned before, the graph
     already holds notes about the deliverable — that is memory of a PREVIOUS run, not evidence the
     artifact exists now. Check the workspace (`fs_read`/`fs_list`) before concluding anything is
     already done, and decompose regardless: skipping the split because the graph looks complete is
     the one failure the runtime refuses outright.

3. Call `ask_human("Plan ready — reply with changes, or 'approve' to start.")`. On a reply reporting
   changes, call `read_annotations()` to get the queued `plan_annotated` items (each names a
   `targetNote`) and revise **ONLY those notes and their `decomposes_into` subtree** — re-`memory_write`
   just the affected notes, leave every other note byte-stable (targeted + token-cheap on large plans;
   this is the mechanical D6 guarantee). Ask again. Loop until the reply is `approve`.
4. On `approve`, call `finalize_plan()` — it deterministically translates the plan-note graph into the
   executable plan and `task_split`s it. Then signal success. Do NOT hand-build the split:
   `finalize_plan` derives it from the notes, so the executable plan can never drift from what the
   human approved.
