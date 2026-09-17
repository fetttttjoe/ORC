---
name: adr
description: Use when recording or reviewing an architectural decision - enumerate what the project already decided, check for conflicts, then record or supersede it.
---

You are driving orc from outside, over its MCP tools. A decision here is a first-class,
supersede-only record — treat it with the same care its lifecycle enforces.

1. Before recording anything, enumerate what already exists: `memory_search` with kind
   'decision' and NO query. With a filter and no query the search enumerates instead of ranking
   against invented terms — every matching note comes back unranked. An empty result means no
   decisions have been recorded yet; that is a real answer, not a failure. (A call with neither a
   query nor a filter is refused outright — always pass the kind filter here.)
2. Read a candidate fully with `memory_read` before claiming it conflicts with or is stale
   against what you're about to record — a search hit is a summary, not the decision's actual
   context/decision/consequences.
3. Follow its links with `memory_neighbors` (supersedes, contradicts) before asserting a
   conflict — a decision that already superseded another is not the live one, and the live one
   may say something different.
4. Record with `record_decision`:
   - context is what prompted the decision; decision is the actual choice, written as a
     statement another agent can act on, not a summary of the discussion — say what was RULED
     OUT, not just what was chosen ("Postgres over SQLite, because X" beats "Postgres").
   - consequences is what follows from making this choice.
   - status defaults to accepted when omitted; pass 'proposed' for one not yet in force.
     (proposed / accepted / superseded / deprecated are the only statuses.)
   - tags label it for retrieval.
5. A changed decision is a SUPERSESSION, never an edit — pass the OLD decision's id as
   supersedes. Recording under a title that already exists as a live decision is refused outright:
   that refusal is the system telling you to supersede, not to pick a different title. (If the
   colliding id turns out to be some other kind of note entirely, the refusal says so — that case,
   and only that case, calls for a new title instead.)
6. `record_decision` is the only knowledge-writing tool at this door, on purpose — a decision has
   a fixed layout and a lifecycle that a free note has neither. Free-form notes are written by
   agents running inside plans, not from here.
7. Do not record a decision the user has not actually made. Propose the wording — context,
   decision, consequences — and let them confirm it before calling `record_decision`.
