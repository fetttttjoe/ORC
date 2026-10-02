---
status: superseded
tags: knowledge, drift, provenance, architecture
supersedes: claim-stamps-are-taken-from-an-injected-per-author-treestamps-provider-never-by
supersededBy: a-claim-s-basis-is-the-code-its-writer-saw-recorded-in-knowledge-written-git-bla
---

# Claims carry no stamp: the reading checkout's git blame is the basis

## Context

The memory store stamped every claim with the revision and anchor blobs of its author's checkout through an injected TreeStamps provider, because one store served many worktrees and stamping from the supervisor's checkout misattributed claims. As files in git, every checkout holds its own copy of each claim it can read.

## Decision

Claims carry no revision or blob stamp. A claim's basis is read from git in the checkout that reads it: the commit git blame gives the claim's line. A claim written in a worktree is uncommitted there, and so its own basis, until it is committed; after a merge, blame follows the line to the commit that introduced it, whose tree holds the code its author saw.

## Consequences

Provenance is correct under concurrent worktrees without a workspace-to-directory stamping seam, and nothing an agent writes can assert a basis. A history rewrite re-points the basis instead of orphaning stamps. Any edit to a claim's line (text, anchors, tags) is a re-assertion and moves its basis; a pure move or a fmt re-sort keeps it. A rewrite that changes the line's text, including `fmt` canonicalising an anchor's symbol, moves the basis as well, so a claim whose code changed before such a rewrite reads clean after it. Reading state means reading git per checkout: blame over the whole corpus takes about 0.3 s.

## Considered

- Keep a per-author TreeStamps provider and write its stamps into the claim lines.
- Record each claim's basis as an event in the log: lost on a log reset, and looked up per branch.
