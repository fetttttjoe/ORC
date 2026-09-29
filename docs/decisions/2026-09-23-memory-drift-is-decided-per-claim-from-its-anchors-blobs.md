---
status: accepted
tags: memory, claims, drift, architecture
---

# Memory drift is decided per claim from its anchors' blobs

## Context

Notes carried a single note-level drift verdict derived from whether any declared path changed since the note's sourceRevision. That is coarse and noisy: an unrelated edit anywhere in a note's path list condemned the whole note, while a note whose claims were each anchored to specific files got no finer signal. Task 2 had already made every claim carry its anchors and a stamped blob per anchor from the author's checkout, so a per-claim verdict was now computable.

## Decision

Drift is decided per claim. A zero-import classifier (packages/contracts/src/claim-drift.ts) classes each claim clean / suspect / unanchored / unknown by comparing its anchors' stamped blobs with the judging checkout (no anchors = unanchored; a stamped blob differing from a known blob, file-gone included = suspect; a null stamp or unreadable probe = unknown; suspect wins over unknown). A note WITH claims is drifted iff at least one claim is suspect; a claim-free note keeps the old note-path rule. Every drift surface goes through one reader, plugins/memory/src/claim-drift-read.ts. A verification snapshots the claims it checked ({claimId, anchors}) and supplies a claim's comparison basis only on an exact id + anchor-set match. Consolidated outcome notes stop declaring paths; restamping stays a claim-free-note concept.

## Consequences

Claimed notes are judged by evidence per statement, so an unrelated edit in a sibling file no longer drifts a note, and a healing write can target the suspect claims that recheck names (suspectClaims / unknownClaims on RecheckedNote). It commits the project to keeping anchors and blob stamps accurate — an unanchored claim is now permanently unverifiable rather than merely coarse — and to routing any new drift surface through claim-drift-read.ts rather than re-deriving the rule. It rules out restamping claims to HEAD as a way to clear drift, and rules out path lists as the drift signal for outcome notes. Nearest existing decision, "Claim stamps are taken from an injected per-author TreeStamps provider", is built on, not superseded.
