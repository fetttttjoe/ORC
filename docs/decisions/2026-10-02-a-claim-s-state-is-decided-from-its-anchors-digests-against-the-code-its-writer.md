---
status: accepted
tags: knowledge, drift, architecture
supersedes: a-claim-s-state-is-decided-from-its-anchors-code-at-the-commit-git-blame-gives-i
---

# A claim's state is decided from its anchors' digests against the code its writer saw

## Context

Phase D decided claim state from each anchor's digest at the commit git blame gives the claim's line. The basis moved to the writer's view: digests asserted in knowledge_written when the log holds them, git blame only when it does not.

## Decision

Each anchor is digested in the working tree: a symbol by the SHA-256 of its leaf tokens without comments, parsed in-process by the tree-sitter StructureProvider; a file by its token digest, or its raw bytes when it has no outline; a directory by its sorted file list. An anchor is unknown when either side cannot be read, suspect when its code is gone, clean when its digest is one a holds check accepted or, with an assertion in the log, one the log asserted for that claim text and anchor; with no assertion, clean when it equals the digest at the commit git blame -w -M1 -C1 gives the claim's line, an uncommitted line being its own basis. A claim with any suspect anchor is suspect, else any unknown makes it unknown; a claim without anchors is unanchored. Backends return readings; the port reads the folded evidence and applies the zero-import rule in packages/contracts/src/claim-state.ts.

## Consequences

Over this repo's last 80 commits, suspect claim-windows are about half the file-level count (bench/knowledge-drift.ts). In files the structure provider outlines, comment and whitespace edits never make a claim suspect; a file anchor on JSON or another file without an outline digests raw bytes. Nothing is stamped into files; a log reset or purge loses assertions and holds checks, and every claim falls back to its blame basis. A claim anchored on a large symbol turns suspect on any edit inside it; anchoring an inner symbol is the remedy. A new backend brings readings and inherits the rule.

## Considered

- Compare each anchor's whole file between the basis and the working tree: 17-50 % of claims suspect per window.
- Stamp each anchor's digest into the claim line: a stamp in every file and a merge conflict on every re-check.
- Use codebase-memory-mcp as the parser: an external index that goes stale, with heuristic TypeScript edges.
