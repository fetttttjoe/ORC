---
status: accepted
tags: knowledge, drift, provenance, architecture
supersedes: claims-carry-no-stamp-the-reading-checkout-s-git-blame-is-the-basis
---

# A claim's basis is the code its writer saw, recorded in knowledge_written; git blame decides only when the log holds no assertion

## Context

The blame basis is a line's last rewrite, not the writer's view of the code: a claim written and its code refactored inside one task, committed together, read clean, and a machine rewrite of a claim line that keeps its text moved the basis past a code change unread.

## Decision

When a claim is added, or a change sets a different text or anchor set, the port records the working-tree digest of each anchor in knowledge_written as an assertion keyed by the claim's id, text and anchor. An anchor with an assertion is clean only when its current digest is one the log asserted or a holds check accepted; the blame basis decides only an anchor the log holds no assertion for. Knowledge files still carry no stamp; fmt and hand edits assert nothing.

## Consequences

A claim invalidated inside the task that wrote it reads suspect after the commit, and re-formatting or re-tagging a line no longer clears a suspect claim. Each write reads its claims' digests once (about 7 ms for three claims). A log reset or purge falls back to the blame rule for every claim, and a hand-written claim keeps the blame rule's exposure to rewrites of its line. One evidence fold over the log feeds both the rule and orc knowledge stats.

## Considered

- Walk the blame back while the parent blob holds the same claim id and text: closes line rewrites but not a claim invalidated before its first commit, and walks history per claim.
- Feed git blame an ignore-revs file of format commits: needs a registry of such commits and leaves the uncommitted window open.
