---
status: accepted
tags: memory, claims, stamps, provenance, architecture
---

# Claim stamps are taken from an injected per-author TreeStamps provider, never by the store shelling git

## Context

Claims must record the revision and the anchor blobs of the checkout the CLAIM WAS WRITTEN FROM, but one memory store serves many workspaces (worktrees) concurrently. The store previously had only config.dir, so stamping from it would silently attribute every author's claims to the serving checkout. Spawning git inside the log transaction would also hold the advisory lock across process spawns, and a caller-supplied blob would let an agent assert provenance it did not have.

## Decision

createMemoryStore takes an injected `stampsFor(author) => TreeStamps` provider rather than shelling git itself; packages/cli/src/runtime.ts is the only place that builds one, via workspaceStamps(dirOf) keyed by author.workspaceId through the kernel's workspace table. The store resolves the provider and takes the revision plus every anchor blob BEFORE log.transaction. TreeStamps answers null whenever git cannot answer and refuses any path escaping its checkout ('..', absolute, symlink-escaping). The memory_write tool's anchor schema has no blob key, so a blob can only come from the store's own stamping.

## Consequences

Provenance is per-author and therefore correct under concurrent worktrees; git never runs under the advisory lock; unstampable writes degrade to null rather than failing. It commits us to the composition root owning workspace→directory resolution (plugins/memory no longer knows how to find a checkout), to callers never supplying blobs, and to any future stamping source (a non-git VCS, a remote) arriving as another TreeStamps implementation rather than as git calls inside the store.
