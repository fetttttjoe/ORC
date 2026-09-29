---
status: accepted
tags: knowledge, architecture, git
---

# Knowledge about the code lives as files in git behind a config-selected port

## Context

The knowledge store kept facts, whys and decisions in SurrealDB, projected from the event log. Measured over 2026-09-14 to 09-23: the link graph, spreading activation and topics were never used (0 calls); memory reads were a small share of how agents learn about the code (195 memory reads and searches against 1,190 fs_read calls); file-level anchors flagged 18-66 % of claims as drifted per 10-commit window; and two resets (09-19, 09-23) erased the knowledge history, which survived only in database dumps. Sharing one server between many users is years away.

## Decision

Facts, whys and decisions about the code are Markdown files in the repository: claims in <package>/knowledge/<path>.md buckets, decisions in docs/decisions/. The event log records only what happened, including every knowledge delivery and write. Consumers depend on one narrow port (KnowledgePort); the backend is a plugin chosen in .orc/config.json (knowledge.plugin, default git-files), so it can be replaced without touching a consumer. A claim's bucket is computed from its first anchor, never chosen by an agent.

## Consequences

Knowledge survives a log or database reset and is reviewed, branched and merged with the code; git log shows every change. Every backend must pass the shared contract suite. Knowledge written on a branch is visible only in that checkout until the branch merges. SurrealDB, the projector and the vault mirror become removable once their last readers move. Ranking uses no learned weight until an A/B test shows a gain.

## Considered

- Keep SurrealDB as the source of truth and add symbol-level drift: rejected, because its graph features went unused and resets kept erasing history.
- A lean cleanup of the old store (drop the unused graph features, hash symbols): rejected, because knowledge would stay outside git, still die with a reset, and never be reviewed with the code.
- Keep a database as the shared source so many users can work on one server: deferred, because multi-user is years away; a server backend can arrive later as another plugin.
