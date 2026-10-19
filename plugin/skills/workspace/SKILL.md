---
name: workspace
description: Use when deciding which checkout a request belongs to - read workspace_list before creating or reusing one, and know what each state needs from you.
---

A workspace is one checkout per request — a plain git checkout, or an orc-created worktree under
.orc/worktrees. Every task belongs to exactly one.

1. `workspace_list` first — read-only, ordered attention-first (the order below). Each row
   carries its state, when it last saw activity, and its task counts.
2. What each state means and asks for, attention-first:
   - dangling — not merged, and the checkout is gone. A human's call in the terminal: merge it or
     archive it.
   - waiting — a task here is awaiting approval, or has an open question. Approve or reply.
   - active — a task here is running. Nothing to do.
   - idle — quiet: nothing running, nothing waiting, not merged, not dangling. Resume it or
     archive it.
   - merged — the merge is recorded. Done.
3. Reuse the current workspace when the ask continues work already in this checkout. Use
   `workspace_new` when it is a separate request that deserves its own branch and worktree.
4. `workspace_new` creates a git worktree + branch for ONE request under the project's
   .orc/worktrees, records it as a managed workspace, and drafts the request as that workspace's
   first task (title required; spec optional, but it IS the request — agents never infer intent
   from a title; base optional — defaults to this checkout's HEAD).
   The session must then work in the returned directory — file operations run elsewhere land in
   the wrong checkout and are not part of this request.
5. Knowledge written in a workspace — decisions included — lives in that branch's files until the
   workspace merges: a claim or decision read back from an unmerged checkout may still be
   rewritten or reverted before it lands. Read it as a working draft, not settled project
   knowledge.
6. Merging and archiving are terminal commands the human runs (orc ws merge, orc ws archive) —
   there is no MCP tool for either. Tell the user to run them rather than implying this session
   can do it.
