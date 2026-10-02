---
status: superseded
tags: knowledge, drift, architecture
supersedes: memory-drift-is-decided-per-claim-from-its-anchors-blobs
supersededBy: a-claim-s-state-is-decided-from-its-anchors-digests-against-the-code-its-writer
---

# A claim's state is decided from its anchors' code at the commit git blame gives its line

## Context

Knowledge about the code moved from the memory store to claim files in git, and claims carry no stamp, so the per-claim comparison of stamped blobs has nothing to compare against. A file-level comparison flagged 17-50 % of this repo's claims per 10-commit window, mostly for edits elsewhere in the anchored file.

## Decision

A claim's basis is the commit git blame -w -M1 -C1 gives its line in the checkout that reads it; an uncommitted line is its own basis. Each anchor is digested at the basis and in the working tree: a symbol by the SHA-256 of its leaf tokens without comments, parsed in-process by the tree-sitter StructureProvider; a file by its token digest, or its raw bytes when it has no outline; a directory by its sorted file list. A changed or vanished digest makes the anchor suspect, an unreadable one unknown; a claim without anchors is unanchored. A knowledge_check holds verdict accepts the digests it saw for that claim text. Backends return readings; the port applies the zero-import rule in packages/contracts/src/claim-state.ts.

## Consequences

Over this repo's last 80 commits, suspect claim-windows fell from 282 file-level to 158 (-44 %, bench/knowledge-drift.ts). In files the structure provider outlines, comment and whitespace edits never make a claim suspect; a file anchor on JSON or another file without an outline digests raw bytes. Nothing is stamped into files or a store, so a log reset loses only holds checks and claims fall back to their blame basis. A claim anchored on a large symbol still turns suspect on any edit inside it; anchoring an inner symbol is the remedy. A new backend brings readings and inherits the rule.

## Considered

- Compare each anchor's whole file between the basis and the working tree: 17-50 % of claims suspect per window.
- Stamp each anchor's digest into the claim line: a stamp in every file and a merge conflict on every re-check.
- Use codebase-memory-mcp as the parser: an external index that goes stale, with heuristic TypeScript edges.
