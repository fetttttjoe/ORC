# Working in this repo

## Never

- **Never `git add` a file that is currently untracked under `docs/superpowers/`.** Most docs there
  are tracked; a handful are deliberately not, and they exist nowhere else. If a doc looks like it
  should be committed, ask.
- **Never run `git stash`, `git checkout -- <path>`, `git restore`, `git reset`, or `git clean`**
  against uncommitted work, and never instruct a subagent to. A subagent ignored this once and came
  within one command of destroying six irreplaceable files.
- **Never commit or push unless asked.** Subagents never commit, stage, or stash — the controller
  runs the gate and commits.
- **Never let a committed file cite an untracked path.** Keep the reasoning, drop the path.
- **Never loosen an exact-set assertion** to `toContain` or a length check. The tool-name sets in
  `packages/cli/src/runtime.test.ts` and `mcp-serve.test.ts` catch real breaks.

## Conventions that differ from the defaults

- **All parsing goes through zod.** Typecasts (`as X`), non-null assertions (`!`), and hand-rolled
  validation are defects here. Never read unknown-shaped data out of SurrealDB or the event log
  without a schema.
- **No scattered string literals.** Table names, field names, tool names, event kinds, headings and
  subcommands come from an enum or exported constant — `enum Tb`, `MEMORY_TOOL_NAME`,
  `MEMORY_LIMITS`, `EVENT_KIND`, `CLAIM_ID_RE`. A literal spelled twice will drift.
- **Comments explain WHY and name the failure that motivated the rule.** Comments here carry
  measured findings a reader cannot re-derive; match that density. A comment stating a ceiling also
  names the upgrade path.
- **Reference docs describe the system as it is.** `README.md` and `docs/*.md` must not narrate
  migrations or name milestones — specs and plans carry the history.
- **Prefer the smallest thing that works** — stdlib over a dependency, one line over fifty, deletion
  over addition. This never shortens the *reading*: trace the whole flow first. Where it conflicts
  with the design rules below, the design rules win — brevity is not an excuse for a bad seam.

## Design — separation of concerns, interfaces, modularity

The bar is "easy to extend and build on", not "it works". A change that works but reads as bolted on
is a design problem: say so and redesign rather than shipping the seam.

- **One responsibility per file.** If you cannot say what a file does in one sentence, it does too
  much. Things that change together live together; split by responsibility, not by technical layer.
- **A pure algorithm gets its own file with zero imports.** `plugins/memory/src/cluster.ts` is the
  model — no database, no embedder, no clock, no config. That is what makes it testable and the
  designated place to extend. Use this shape whenever logic separates from where its data lives.
- **Interfaces are narrow and named.** A consumer should be usable without reading the
  implementation, and the implementation replaceable without touching consumers. If changing
  internals breaks a caller, the boundary is wrong.
- **Respect the pipeline direction: log → per-event projection → stateless derivation.** The event
  log is the only source of truth. A derived stage may never be the only writer of a fact; nothing
  may live solely in the read model, which is disposable and rebuilt from the log.
- **One writer per concern.** The store writes events and never touches SurrealDB; the projector
  owns the read model. Do not reach across that line for convenience.
- **Add a compile-time guard when a new field could be silently dropped** — see `DraftCoversTiers`
  and `FitterCoversNote`, which exist because a forgotten field leaked 112 KB into a 1 KB budget. A
  guard that fails the build beats a review that might catch it.
- **Extend at the seam; never special-case at the call site.** A conditional added to a shared path
  to make one caller work is the shape to avoid.

## Judgement

- **Ask when two readings would produce materially different work** — a contract's semantics, a
  schema change, what a tuned constant should mean. One question costs less than the wrong build.
- **Never ask about something you can measure.** Probe it, report what you observed. Three
  confidently-documented claims here turned out false under measurement; a doc is a lead, the code
  and a probe are evidence.
- Make routine calls yourself and state the assumption. Reserve blocking questions for where
  proceeding wrongly would be unsafe or waste the work.
- **Raise a finding that contradicts an instruction rather than following it silently.** Briefs in
  this repo have been wrong more than once. Check the claim, then say so.
- Report outcomes as they are: if tests fail, show the output; if a step was skipped, say so.

## Testing

- **Every behavioural fix needs a test, and you watch it fail first.** A test that cannot fail is
  worse than none — it reports safety that does not exist. State the observed failure, not just the
  pass.
- **Teardown is unconditional** — `finally`, `afterAll`, or the file's existing `cleanup` array. A
  bare `await port.shutdown()` after assertions leaks a DBOS runtime when anything above it throws,
  and poisons every later test file.
- The full suite is ~210s and needs Postgres (:5433) and SurrealDB (:8000) up. Run the files you
  touched while working; run the whole suite as the gate before committing.

## Gotchas

- **A record id deleted and re-created inside ONE SurrealDB transaction stays deleted at commit.**
  Measured. A table refresh must delete only genuinely-stale rows and upsert survivors in place.
- **surqlize's `.inside().not()` emits unparenthesised `!x IN y`**, which SurrealQL reads as
  `(!x) IN y` and which matches nothing. Use `.notInside()`.
- **An optional field set to `undefined` is not omitted — it erases the stored column.** Use the
  conditional-spread idiom `...(x !== undefined && { x })` the surrounding code uses.
- **Bun's `.env` pickup is cwd-relative with no walk-up.** Use `loadProjectEnv`; a shell export in
  one terminal is invisible to a supervisor started elsewhere.
- **A tuned constant quoted in a doc goes stale silently** — nothing fails, the sentence just stops
  being true. When you change one, grep the docs for its old value.
