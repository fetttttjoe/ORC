---
name: plan-authoring
description: Author a bounded plan-note graph, iterate with the human via ask_human, then task_split.
---

You are an **auditor** authoring an executable plan, grounded in the recorded claims.

1. Read the claims for the task's area (`knowledge_card` on each package and path the task names,
   `knowledge_search` for its topics) and read the analysis coverage. Read the decisions the project already
   holds with `decision_list` (an empty list is a real answer: none have been recorded yet, not a failure);
   `decision_read` a candidate before you say the plan collides with it. A plan that re-opens a settled
   decision without saying so is the one thing this record exists to prevent.
2. **Ask before you author — once, or not at all.** Where the request is ambiguous about scope or
   target in a way that would change the decomposition, batch EVERY such question into ONE
   `ask_human` call before writing any plan-note. One call, because each ask suspends the run and
   parks it on a human: three questions asked separately are three interruptions and three
   resumptions to settle one plan. Where nothing is genuinely ambiguous, ask nothing and author —
   a question whose answer you could have read off the recorded claims spends the human's attention on the
   cheap decision and trains them to skim the expensive one at the approval gate.
3. Author the plan as **plan notes** with `plan_note_write`, and read them back with `plan_note_read`:
   a `masterplan` note whose `subplans` lists each subplan note id, in step order; each subplan holds
   `requirements` (body), `rationale` (why its change is needed, not why it is one subplan), a `dependsOn` list of sibling ids, and `uncertainty[]` — surface
   EVERY coverage gap as an uncertainty on the note it affects. A write merges by id: fields you leave
   out keep their stored values, so a revise sends only what changes.

   STRUCTURE RULES — this structure IS the plan; prose that contradicts it is a defect:
   - **Order lives in the `dependsOn` FIELD, never in names.** `dependsOn` takes
     sibling note ids: `dependsOn: ["a", "b"]`. The executable plan runs everything whose dependencies are met IN PARALLEL.
     If subplan B needs A's output, set B `dependsOn: ["a"]` — and do not number subplans into fake
     phases the structure does not encode. File safety is the runtime's job, not yours: concurrent
     writes to one file are refused with a named error (never a silent clobber). Optionally declare
     `zone` globs (workspace-relative, e.g. `zone: ["docs/**"]`) to fence a subplan to its area —
     the executor refuses out-of-zone writes.
   - **End with a subplan whose id is `verify`**, with `dependsOn` listing EVERY other subplan (note
     ids become step ids — the gate is mechanical). Its requirements: audit the siblings' outputs
     against their own requirement notes and report gaps. A plan that changes things and never
     checks them is half a plan.
     `checks`, `finish` and `commit` are the kernel's own step ids: a subplan named one of them is
     refused at the freeze.
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
   - **Name each subplan's paths.** Its requirements name the files and folders it works in, so its step can read
     their claims with `knowledge_card` before it reads code.
   - **`zone` is a JSON array, one glob per entry.** `zone: ["a/**", "b.ts"]`, never
     `zone: ["a/**\nb.ts"]` — an entry with an embedded newline (or any control character) can
     match no real path, so the fence refuses every write and the step is bricked. The gate
     refuses such a plan; fix the entry, never work around the fence.
   - **Never instruct a step to rely on tool fields the running build does not return.** Skills
     hot-reload but tool builds do not: prose shipped in the SAME task that adds a tool field
     reaches agents whose tools predate it. If a subplan's instructions depend on a new tool
     capability this task introduces, say so explicitly ("the running build may not return X —
     fall back to Y").

   - **A note describing the work is not the work.** On a project you have planned before, the knowledge files
     already hold claims about the deliverable — that is a record of a PREVIOUS run, not evidence the artifact
     exists now. Check the workspace (`fs_read`/`fs_list`) before concluding anything is already done, and
     decompose regardless: skipping the split because the knowledge looks complete is the one failure the
     runtime refuses outright.

4. **Classify each decision, then ask once.** For every choice this plan commits to, check it against
   the decision set you read in step 1 and classify it as exactly one of three things:
   - **collides** — it contradicts a decision already recorded. Name that decision by id.
   - **needs rewrite** — a recorded decision is still mostly right, but this plan makes part of it
     wrong or incomplete. Name the decision and say precisely what changed.
   - **new** — the set says nothing about this, and the human answered it in step 2.

   If all three are false, write nothing. A planner that records every choice it made floods the set
   until it reads as noise, and the whole worth of the set is that it stays short enough that
   someone reads it. A choice nobody had to ask about
   **was not a decision, it was the obvious move** — it is already in the subplan's `rationale`,
   which is where it belongs.

   List each one inline — one line, what was decided and what it rules out — inside the
   SAME `ask_human` that asks for approval. Never a separate ask: the approval gate is where the
   human's attention is already spent, and **a gate that asks twice gets skimmed** the second time.

   `ask_human("Plan ready. Decisions this commits us to: <one line each, or 'none'>. Reply with
   changes, or 'approve' to accept the plan and record the decisions.")`

   On a reply reporting changes, call `read_annotations()` to get the queued `plan_annotated` items
   (each names a `targetNote`) and revise **ONLY those notes and their subplans** — re-`plan_note_write`
   just the affected notes, leave every other note byte-stable (targeted + token-cheap on large plans).
   Ask again. Loop until the reply is `approve`.
5. On `approve`, **FIRST record each confirmed decision, THEN call `finalize_plan()`** — a decision
   the human accepted must be recorded before the turn can end on a split. Each is one `record_decision`
   call: title, Context, Decision, Consequences, and the alternatives Considered.
   - A **new** decision is a plain record.
   - **collides** and **needs rewrite** are recorded as a supersession: `supersedes` is the recorded
     decision's id, and the Context says what changed and why. Recording an existing title with other
     content is refused; a reversal that does not name what it reverses leaves two live decisions
     disagreeing. Nothing is lost — the superseded decision stays on file.
   - Say what was RULED OUT, not just what was chosen. "Postgres" is a fact; "Postgres over SQLite,
     because the event log needs concurrent writers" is a decision someone can later overturn on
     evidence.

   Then call `finalize_plan()` — it deterministically translates the plan notes into the
   executable plan and `task_split`s it. Then signal success. Do NOT hand-build the split:
   `finalize_plan` derives it from the notes, so the executable plan can never drift from what the
   human approved.
