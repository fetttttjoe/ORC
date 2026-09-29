---
status: accepted
tags: memory, claims, decisions, adr, provenance
---

# A memory write states why it happened and which decision it served

## Context

Claim history recorded WHAT changed and when, never why, so a later reader met a retired claim with no way to recover the intent behind retiring it — and decisions recorded the option taken while the options weighed evaporated. Provenance could have lived in a separate audit log, or been inherited from a prior write, or been stored as extra note fields; each of those lets provenance drift away from the write it describes.

## Decision

Provenance is stated per write and validated at the single write gateway. ClaimWrite carries `why` (prose) and `decision` (a note id); both ride MemoryWrittenPayload and store.write opts, are never inherited by a later write, and plugins/memory/src/store.ts validates `decision` against the log inside the write transaction — it must be a live, non-archived semantic decision note in the same scope, or STORE_REFUSAL.notADecision. Consequently claimHistory folds a note's events into validity INTERVALS carrying addedBy/retiredBy acts (author, revision, why, decision) rather than flat entries, and the alternatives a decision weighed are rendered as a `## Considered` section of the ADR body — the body is their only stored copy, not a second note field.

## Consequences

Every write door must supply or default why/decision, and a write naming a non-decision note is refused rather than silently stamped. ClaimHistoryEntry is removed with no alias and no back-compat shim: every reader of claim history is now interval-shaped, and a revival appends a new interval instead of reopening the old one. Considered is readable only by parsing the ADR body (parseAdrBody accepts three OR four sections), which keeps `orc memory add --kind decision` bodies legible but means no query can filter on considered options. Rules out inheriting provenance across writes, and rules out a parallel provenance log.
