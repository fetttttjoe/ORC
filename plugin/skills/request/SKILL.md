---
name: request
description: Use when turning a user's ask into orc work - creating a request, reading its plan back, and driving it through the human approval gate to a run.
---

You are driving orc from outside, over its MCP tools. Ground every step in a tool read.

1. Start from `project_status` — it lists every request with its status and workspace. Do not
   create a duplicate of an open task; if one already covers the ask, continue it instead.
2. Decide which workspace the request belongs to before creating anything — reuse the current
   checkout for follow-up work, or make a new one; see the workspace skill for the exact rule.
3. Create the request with `new_request`. title is a short label; spec carries the actual intent
   (goal, constraints, outputs) — agents never infer intent from the title.
   - grounded (`{modelRef, cwd}`, requires spec and cwd) makes an agent analyze the repo and
     propose a decomposition. Pick this for repo work.
   - Omitted, a quick single-step task is created instead. Pick this for a simple one-shot job —
     it has no plan yet and needs `propose` next.
   - workspaceId targets a workspace other than the one this server runs in; `workspace_list`
     names them, `workspace_new` makes one.
4. For a quick task, call `propose` (modelRef, optional skillRefs) to draft its single-step plan.
   A grounded task's decomposition becomes its plan automatically — do not call `propose` for one.
5. Before anything runs, read the plan back: `task_plan` (steps, models, dependencies, which
   version is approved) and, for a grounded task, `plan_notes` (the decomposition — subplans,
   dependsOn, zone, skillRefs/toolRefs, uncertainty).
6. To change a plan before approval: `annotate` queues feedback on one plan-note; `revise`
   annotates a scoped set of notes and wakes the plan agent to redo them.
7. Approval is the human's, structurally, whether the task is quick or grounded — `run` refuses
   any task with no approved plan version. `approve` REFUSES under the default `--autonomy gated`
   and names the way forward (the orc UI, or `orc approve <taskId>`); only under `--autonomy full`
   does this session's own `approve` call work, attributed `approvedBy: mcp`. Hand the plan to the
   user and STOP — do not look for a way around a gated refusal.
8. After approval, start it with `run` (defaults to the task's own workspace; pass cwd only to
   override it). Never invent a model ref — call `available_models` first, always.
9. Watch it with `task_transcript` (messages, tool calls, questions — recent items, truncated) and
   `recent_activity` (the event tail; pass the previous call's maxSeq as sinceSeq to read only
   what's new). Report what the tools show, never "it's working" without checking.
10. `reply` answers a task's open question and resumes the step waiting on it.
11. `retry` only works on a task that is `blocked`, and refuses when the block is a rejected
    verdict rather than a crash — the same siblings would fail the same way again. That refusal
    names the fix: `revise` the plan and get the new version approved, not retry. `cancel` is
    terminal and sweeps the task's orphaned notes — confirm with the user before calling it.
