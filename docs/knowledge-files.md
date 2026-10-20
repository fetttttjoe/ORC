# Knowledge files

What the project holds true about its code lives in the repository, beside the code it describes, and is
reviewed, branched and merged with that code. There are two kinds of file:

- **claim buckets**: one-line claims, each anchored to the code it is about;
- **decision files**: one architectural decision per file, under `docs/decisions/`.

This page is the format the git-files backend (`plugins/knowledge-git`) reads and writes. `orc knowledge fmt`
puts a hand-edited file back into canonical form, and `orc knowledge check` reports what it cannot read. Agents
are told to write only through `knowledge_write`, `knowledge_check` and `record_decision`, never with file
tools. A person writes through `orc knowledge` and `orc adr`, or edits by hand and runs `fmt`.

## Where a claim lives

A claim is filed by its **first anchor**. Nobody chooses the file.

A **package root** is the deepest folder that holds a manifest (`package.json`, `pyproject.toml`, `go.mod`,
`Cargo.toml`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile` or `mix.exs`) which git tracks or does not
ignore. A path inside no package belongs to the repository root.

| First anchor | Bucket | Bucket title |
|---|---|---|
| a file `<package>/<path>` | `<package>/knowledge/<path>.md` | the file's path |
| a folder anywhere inside a package | `<package>/knowledge/README.md`, the package's README bucket | the package root |
| a file outside every package | `knowledge/<path>.md` at the repository root | the file's path |
| a folder outside every package, or no anchor | `knowledge/README.md` at the repository root | `project` |

For example, `packages/contracts/knowledge/src/knowledge.ts.md` holds the claims whose first anchor is
`packages/contracts/src/knowledge.ts`, and `packages/kernel/knowledge/README.md` holds those whose first anchor
is a folder of `packages/kernel`.

Only Markdown files inside the knowledge folder at a package root are buckets. A folder of the same name deeper
in a package is ordinary content. The folder name is the backend's `dirName` option (default `knowledge`), and
the manifest list is its `manifests` option. A claim whose first anchor changes moves to its new bucket at its
next write or at `orc knowledge fmt`; until then `check` reports it as misfiled.

## A bucket

```markdown
# packages/kernel/src/storage/event-log.ts

## Facts
- EventLog.append redacts an event's payload before it validates it. {k3f9a2x7 @packages/kernel/src/storage/event-log.ts#EventLog.append #redaction}

## Why
- Validation runs on the redacted payload, so a schema error can never quote a secret back. {p0q8w1e4 @packages/kernel/src/storage/event-log.ts#EventLog.append #redaction}
```

- The first line is the title, `# <title>`, before any section. A bucket has one.
- Claims sit under `## Facts` (class `fact`: what the code does now) or `## Why` (class `why`: the reason it is
  that way), in that order. Any other heading is a problem.
- Every other non-blank line must be a claim line (`- …`). Free text is a problem: a bucket holds claims and
  nothing else.
- In canonical form an empty section is left out, and the claims of a section are sorted by their first anchor
  (path, then symbol) and then by id. Claims with no anchor sort first.

## The claim line

```
- <text> {<id> @<path>[#<symbol>]… #<tag>… <url>… adr:<decision>}
```

| Token | Meaning | Rules |
|---|---|---|
| `<text>` | the claim, one standalone sentence | one line, at most 1,000 characters, trimmed, not ending in `}` |
| `<id>` | the claim's id, always the first token | 8 characters of `a-z0-9`, unique in the checkout |
| `@<path>` | an anchor: the code the claim is about | at most 8; the first decides the bucket |
| `@<path>#<symbol>` | an anchor at one symbol in a file | see below |
| `#<tag>` | a tag, for search | at most 8; lowercase letters and digits in words joined by `-`, at most 40 characters |
| `<url>` | a source the claim was learned from | at most 8; credential-free `http(s)` URLs, no spaces, `<`, `>`, `{` or `}` |
| `adr:<decision>` | the decision this claim serves | at most one; it must name a decision in this checkout |

In canonical form the tail holds the id, then the anchors in their written order, the tags sorted, the sources in
their written order, and the decision. Braces inside the text are fine; only a `{…}` that ends the line is the
tail.

### Ids

A claim keeps its id for life: a change rewrites the line under the same id, and a retire removes the line. A
new claim gets a random id. When an agent's tool call is retried, its additions get ids derived from the call's
idempotency key, so the retry writes the same claims instead of new ones. A line written by hand without a
tail, or with a tail whose first token is an anchor, a tag or a source, is a claim waiting for its id: `fmt`
assigns one.

### Anchors and symbols

An anchor path is relative to the repository root, uses `/`, and cannot be the root itself or contain `..`,
whitespace, `#`, `@`, `{` or `}`. A write refuses an anchor that does not exist in the checkout or that resolves
outside it.

A symbol is a name from the file's outline. The outline comes from the structure provider the CLI hands the backend;
the one shipped (`plugins/structure-treesitter`) reads TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`,
`.mts`, `.cts`, `.mjs`, `.cjs`). A name is the dotted chain of the definitions that contain it: `EventLog.append`
for a method, `buildRuntime.port.stepTools` for a function nested in an object passed inside `buildRuntime`. A
symbol written in its short form (`append`, when only `EventLog.append` matches it) is expanded to the full name
when it is written and by `fmt`. An unknown symbol is refused with the closest names. A file with no outline cannot
carry a symbol: anchor the file itself.

An anchor names a file, a symbol or a folder, and its code is digested as follows:

- a file with an outline is digested over its syntax tokens without comments, so an edit to a comment or to
  whitespace leaves it unchanged;
- a symbol is digested over that symbol's own spans;
- a file with no outline is digested over its bytes;
- a folder is digested over the sorted list of the files in it, so adding, removing or renaming a file changes
  it and editing one does not.

### Tags, sources and decisions

Tags are for search: `knowledge_search` and `orc knowledge search` rank claims over their text, tags, anchor paths
and symbols. Sources are how a claim says where it was learned; the `web-research` skill asks every research
claim to carry the pages it used. A decision link (`adr:<slug>`) ties a claim to the decision it serves, and a
write that names a decision this checkout does not hold is refused.

## Decision files

A decision is one file, `docs/decisions/<yyyy-mm-dd>-<slug>.md` (the backend's `decisionsDir` option, which may
not sit inside a knowledge folder). The slug is the title lowercased with every run of other characters turned
into `-`, at most 80 characters, and it is the decision's id. The date is the UTC day it was recorded.

```markdown
---
status: accepted
tags: knowledge, git
supersedes: an-older-decision
---

# Knowledge about the code lives as files in git behind a config-selected port

## Context

The forces that made a decision necessary.

## Decision

What was decided, as a statement another agent can act on.

## Consequences

What becomes easier, harder or forbidden.

## Considered

- An alternative and why it was not taken.
  A continuation line is indented two spaces.
```

- The frontmatter holds `status` (required: `proposed`, `accepted`, `superseded` or `deprecated`) and, optionally,
  `tags` (comma-separated), `supersedes` and `supersededBy`; a write puts them in that order. Any other key is a
  problem.
- After the frontmatter come one `# ` title and the sections Context, Decision and Consequences, in that order
  and none empty, then an optional Considered section of `- ` options.
- No section may contain a line that starts with `## `.
- A Markdown file there named otherwise (other than `README.md`) is a problem, and so is a slug held by two
  files (neither is read).

A decision changes only by supersession. `orc adr supersede <oldId> <title>`, or `record_decision` with
`supersedes`, writes the new file and marks the old one `status: superseded` with `supersededBy: <new id>`. Only
an accepted decision may supersede, and an already superseded one cannot be superseded again. Recording a title
that already exists with other content is refused. `check` reports a `supersedes` or `supersededBy` that names
no decision, a pair that names each other on one side only, and a `superseded` status without its
`supersededBy` (or the reverse).

## The commands

| Command | What it does | Needs the event log |
|---|---|---|
| `orc knowledge card <path>` | the claims anchored at or under a path (`.` for all) | no |
| `orc knowledge search <query>` | claims ranked for a query | no |
| `orc knowledge add --class fact\|why --text <text> [--anchor <path#symbol>…] [--tag …] [--source …] [--decision <slug>] [--why <text>]` | records one claim | yes |
| `orc knowledge retire <ids…> --why <text>` | retires claims | yes |
| `orc knowledge fmt` | assigns missing ids, restores canonical form, expands short symbols, moves misfiled claims, then reports what is left | no |
| `orc knowledge check` | validates every bucket and decision file; prints `<file>:<line>  <problem>`, exits 1 on any | no |
| `orc knowledge drift [paths…] [--json]` | the claims that are not clean and their anchors, then the count per state; never fails | no: without it, states come from git blame alone, and the output says so |
| `orc knowledge verify <id> holds\|false\|unknown --why <text> [--retire \| --text <corrected>]` | records a check of one claim; a false check retires or corrects it | yes |
| `orc knowledge stats [--top <n>] [--json]` | what agents were handed, and the files they read that no claim covers | yes |

`fmt` rewrites only a bucket whose only problems are missing ids; a bucket with a line it cannot read is left
for a person, and every write that touches that bucket is refused until the line is fixed. A bucket that grows
past 40 claims draws a warning on write: the code it describes may do too much.

| `check` reports | Fix |
|---|---|
| `missing id`, `not in canonical form`, `belongs in '<bucket>'`, `symbol '<s>' is the short form of '<full>'` | `orc knowledge fmt` |
| `id '<id>' is also in '<bucket>'` | the same id in two buckets: keep one line |
| `has no symbol '<s>' — closest: …` | fix the anchor to a listed name, or anchor the file |
| `anchor '<path>' does not exist in this checkout` | the code moved: correct the anchor, or retire the claim |
| `names decision '<slug>', which is no decision in this checkout` | record the decision, or drop the `adr:` link |
| a line it cannot parse | edit the line by hand |

## The four claim states

A claim's state compares the code at its anchors now with the code it was last written or confirmed against.
The **basis** is the commit that last wrote the claim's own line, found by `git blame` on the bucket (ignoring
whitespace, following moved and copied lines). A line not yet committed has the working tree as its basis. The
log adds **evidence**: the digests each anchor had right after a write that stated the claim, and the digests a
`holds` check confirmed. Evidence is kept per claim id and text, so rewording a claim starts its evidence afresh.

| State | When | What a reader does |
|---|---|---|
| `clean` | every anchor's code is what the claim was written or confirmed against | trust it |
| `suspect` | an anchor's code changed since then, or the anchored file, folder or symbol is gone | read the anchors, then check it (`holds`) or correct it (change or retire) |
| `unknown` | an anchor cannot be digested: a symbol on a folder or on a file with no outline, or a symbol not found in a file that does not parse cleanly | read the code if the claim matters |
| `unanchored` | the claim has no anchor | nothing to compare against |

Each anchor is judged in this order, and the claim takes the worst of its anchors (suspect, then unknown, then
clean):

1. an anchor that cannot be digested is `unknown`;
2. an anchor whose target is gone is `suspect`;
3. an anchor whose current digest a `holds` check confirmed is `clean`;
4. an anchor with digests asserted by writes is `clean` only at one of them;
5. otherwise the anchor is `clean` exactly when its current digest equals its digest at the basis.

So a claim stays clean through edits that do not touch its anchors' code. A `holds` check clears it until that
code changes again. A false claim is corrected by a change or a retire, through `knowledge_write` or a `false`
check that carries the patch.
