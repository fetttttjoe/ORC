// tools are the same read APIs and OrcActions the UI uses: it cannot bypass the action layer
import { tool, type ToolSet } from 'ai'
import type { GraphNode, NodeType } from './graph-wire'
import { z } from 'zod'
import type { OrcActions } from './actions'
import { ScopeType } from '@orc/contracts/scope'
import type { CopilotFocus } from './copilot-focus'
import type { ProjectSessions } from './sessions'

import { snip } from './summarize'
import { viewOf } from './views/registry'
import { VIEW, WIRE } from './wire'
import type { KnowledgeHealth, ResolvedTool, SupervisorHealth, WorkspaceWithHealth } from '@orc/contracts'
import { DecisionFilter, DecisionInput, errorMessage, EventKind, groupByWorkspace, KnowledgeHealthState, KnowledgeToolName, toolError, type Origin } from '@orc/contracts'

// 'read-only' = server outside a project; 'foreign-project' = viewing another project's chat
export type CopilotMode = 'act' | 'read-only' | 'foreign-project'

const MODE_LINES: Record<CopilotMode, string> = {
  act: `You may execute actions (create requests, propose, run, reply, refine plans). Plan approval is HUMAN-ONLY — you have no approve tool: present the plan (steps, models, dependencies), then point the user at the approve button in the request view or \`orc approve <taskId>\`. Confirm with the user before cancel. Prefer grounded requests for repo work (the agent analyzes the codebase first); quick requests for simple one-shot jobs. After acting, state what you did and what happens next.`,
  'read-only': `This session is read-only: explain state and suggest the CLI commands the user could run.`,
  'foreign-project': `This chat is READ-ONLY: actions run only in the project chat where orc graph was started. If the user wants to act, tell them to switch to that chat — or restart orc graph from this project's directory.`,
}

// the selection in the user's words, so 'run this' resolves to the pane they are reading
const focusBlock = (f: CopilotFocus): string =>
  f.type === ScopeType.task
    ? [
        `You are looking at the request "${f.title}" (status: ${f.status}).`,
        `Its spec: ${f.spec}`,
        ...(f.subtasks.length > 0 ? [`Its subtasks: ${f.subtasks.map(t => `${t.title} [${t.id}] (${t.status})`).join('; ')}`] : []),
      ].join('\n')
    : `You are looking at the workspace "${f.title}". Its requests: ${f.tasks.map(t => `${t.title} [${t.id}] (${t.status})`).join('; ')}`

export function copilotSystemPrompt(projectName: string, mode: CopilotMode, defaultCwd: string | undefined, focus: CopilotFocus | null): string {
  return [
    `You are the orc copilot for the project "${projectName}" — a guide through a multi-agent orchestrator.`,
    `Requests (tasks) move through: draft → plan proposed → approved (human gate) → running steps → done, with verified output artifacts and project knowledge kept as claim files in the repository.`,
    `Ground every answer in tool reads — never invent task ids, statuses, or content. Read before you act.`,
    `Model refs have the form provider/model (e.g. anthropic/…). Call available_models before choosing one — never guess a ref.`,
    MODE_LINES[mode],
    ...(focus ? [focusBlock(focus)] : []),
    `The UI already streams every event to the user live — NEVER offer to poll, watch, or "check back periodically". After an action, verify once with project_status/recent_activity, report, and stop.`,
    defaultCwd
      ? `The project's working directory is ${defaultCwd} — use it as the cwd (grounded.cwd / run's cwd) unless the user names a different EXISTING absolute path. NEVER invent paths (no /workspace/…); a non-existent cwd is rejected.`
      : `When the user names a folder/repository to work on, that ABSOLUTE path is the cwd: pass it as grounded.cwd (grounded requests) or as run's cwd — the agents' file tools are scoped to that directory. Never run repo work in a different cwd, and NEVER invent paths.`,
    `A quick request is only runnable after propose → approve (the human gate): create it, propose a plan, then hand review to the user — approval happens via the UI approve button or \`orc approve\`, never by you. When a request is ambiguous about scope or target, ask ONE clarifying question before any mutating tool call.`,
    `HONESTY ABOUT PROGRESS: after starting or resuming runs, VERIFY with project_status/recent_activity before describing progress. A step_failed or task status 'failed' means it FAILED — report the error text verbatim and propose the fix. Never describe agents as 'working' unless the activity log shows it.`,
    `If a tool call fails, read its error message — it usually names the fix. Do not retry the same input more than once.`,
    `Be concise. When the user is unsure, propose a concrete next move.`,
  ].join('\n')
}

// the web copilot's toolset reshaped for any ResolvedTool consumer, such as the MCP server
export function asResolvedTools(tools: ToolSet): ResolvedTool[] {
  return Object.entries(tools).map(([name, t]) => {
    const schema = t.inputSchema as z.ZodType
    const { $schema: _drop, ...inputSchema } = z.toJSONSchema(schema)
    return {
      ref: `orc/${name}`, name,
      description: typeof t.description === 'string' ? t.description : name, // ai v7 allows fn descriptions; ours are strings
      inputSchema: inputSchema as Record<string, unknown>,
      execute: async (input: unknown) => {
        // the MCP door calls execute with raw client JSON, so parse here; the web door's SDK already did
        const parsed = schema.safeParse(input ?? {})
        if (!parsed.success) return toolError(parsed.error)
        try {
          const out = await (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(
            parsed.data, { toolCallId: 'mcp', messages: [] })
          return { output: out, isError: false }
        } catch (err) {
          return toolError(err)
        }
      },
    }
  })
}

export function buildCopilotTools(deps: {
  // exactly the two reads this door performs: narrow so a composition without a full store serves it
  sessions: Pick<ProjectSessions, 'model' | 'snapshot'>
  actions: OrcActions | null
  projectId: string
  // every mutation is stamped with it: a copilot call's events read as one conversation
  origin: Origin
  listModels?: () => Promise<string[]>
  // optional: absent omits the field, since [] would read as 'no workspaces', never true
  listWorkspaces?: () => Promise<readonly WorkspaceWithHealth[]>
  // Absent means project_status omits the field: a fabricated "ok" would read as healthy knowledge.
  health?: () => Promise<{ knowledge: KnowledgeHealth; supervisor?: SupervisorHealth }>
}): ToolSet {
  const { sessions, actions, projectId, origin, listModels, listWorkspaces, health } = deps
  const taskId = z.string().min(1)

  const read: ToolSet = {
    ...(listModels ? {
      available_models: tool({
        description: 'List every usable model ref (provider/model), fetched live from the providers. ALWAYS call this before choosing a modelRef — never invent one.',
        inputSchema: z.object({}),
        execute: async () => ({ refs: await listModels() }),
      }),
    } : {}),
    project_status: tool({
      description: 'List every request (task) in this project with its status, the workspaces (checkouts) they are worked in, plus graph counts and knowledge health (claims, suspect claims). Start here.',
      inputSchema: z.object({}),
      execute: async () => {
        const { graph } = await sessions.snapshot(projectId)
        // a failed lookup omits the field, never []: one optional dep must not sink project_status
        const workspaces = await listWorkspaces?.().catch(() => undefined)
        // Record<NodeType, number> makes a missing key a compile error
        const counts: Record<NodeType, number> = { task: 0, step: 0, artifact: 0, model: 0 }
        for (const n of graph.nodes) counts[n.type]++
        const h = health
          ? await health()
            .catch((err: unknown) => ({ knowledge: { state: KnowledgeHealthState.unavailable, reason: errorMessage(err) } }))
          : undefined
        const tasks = graph.nodes.filter(n => n.type === 'task')
        // narrowed here: GraphNode.workspaceId is optional across node kinds; one grouping pass
        const byWorkspace = workspaces && new Map(
          groupByWorkspace(
            workspaces.map(w => w.workspace),
            tasks.filter((n): n is GraphNode & { workspaceId: string } => n.workspaceId !== undefined),
          ).map(g => [g.workspace.id, g.items]),
        )
        return {
          tasks: tasks.map(n => ({ taskId: n.id, title: n.label, status: n.detail })),
          counts,
          // from this call's task list; tasks still lists orphans and archived-workspace tasks
          ...(workspaces && {
            workspaces: workspaces.map(({ workspace: w, health }) => ({
              id: w.id, title: w.title, kind: w.kind, branch: w.branch, cwd: w.cwd,
              taskIds: (byWorkspace?.get(w.id) ?? []).map(n => n.id),
              // passed through whole: the same verdict as orc ws ls and workspace_list
              health,
            })),
          }),
          ...(h && { knowledge: h.knowledge }),
          // "is anything driving?" — a driver seeing every task idle needs this before anything else
          ...(h && 'supervisor' in h && h.supervisor && { supervisor: h.supervisor }),
        }
      },
    }),
    task_plan: tool({
      description: 'Read a task’s plan versions (steps, models, dependencies) and which version is approved.',
      // derived from the plans view's params: a drifting schema asks for a field the read ignores
      inputSchema: WIRE[VIEW.plans].params,
      // an allowlist: a field added to the plans view for the browser must not cost model tokens
      execute: async ({ taskId: id }) => {
        const plans = await viewOf(sessions, projectId, VIEW.plans, { taskId: id })
        if (!plans) return { error: 'no plan proposed yet' }
        const { visual, ...rest } = plans
        return { ...rest, ...(visual && { visual: { version: visual.version, waves: visual.waves } }) }
      },
    }),
    task_transcript: tool({
      description: 'Read a task’s agent conversation (messages, tool calls, questions, signal). Recent items only; tool payloads are truncated — read an artifact or the file itself for the full text.',
      // the transcript view's params plus this door's bound: a model reads 50 items, a pane thousands
      inputSchema: WIRE[VIEW.transcript].params.extend({ limit: z.number().int().min(1).max(50).optional() }),
      // bounded: one result was 88KB; questions and signals pass through verbatim, never truncated
      execute: async ({ taskId: id, stepId, limit }) =>
        (await viewOf(sessions, projectId, VIEW.transcript, { taskId: id, stepId }) ?? []).slice(-(limit ?? 30)).map(i =>
          i.kind === 'message' ? { ...i, text: snip(i.text, 400) }
          : i.kind === 'tool' ? { ...i, input: snip(JSON.stringify(i.input), 400), output: snip(JSON.stringify(i.output), 400) }
          : i),
    }),
    plan_notes: tool({
      description: 'Read a grounded task’s decomposition plan-notes (the split-up: subplans, dependencies, zones, skills/tools, models, uncertainty).',
      inputSchema: WIRE[VIEW.planNotes].params,
      // modelRef is conditional: '' means inherit, and an empty string reads as a choice
      execute: async ({ taskId: id }) =>
        ((await viewOf(sessions, projectId, VIEW.planNotes, { taskId: id }))?.notes ?? []).map(n => ({
          id: n.id, title: n.title, summary: snip(n.summary, 400), rationale: snip(n.rationale, 400),
          body: snip(n.body, 400), uncertainty: n.uncertainty, subplans: n.subplans,
          dependsOn: n.dependsOn, zone: n.zone, skillRefs: n.skillRefs, toolRefs: n.toolRefs,
          ...(n.modelRef ? { modelRef: n.modelRef } : {}),
        })),
    }),
    recent_activity: tool({
      description: 'The latest events (one line each) — what just happened. scope says what to read: {"type":"project"} for everything, {"type":"task","id":"…","subtree":true} for one request and its subtasks, {"type":"workspace","id":"…"} for a checkout, {"type":"chat","id":"…"} for one conversation. Pass the previous call’s maxSeq as sinceSeq to read only what is new, and kinds to watch specific event kinds.',
      // timeline params narrowed: no beforeSeq, limit 50 not 1000 (paid per token); scope stays required
      inputSchema: WIRE[VIEW.timeline].params.pick({ scope: true, sinceSeq: true, kinds: true }).extend({
        limit: z.number().int().min(1).max(50).optional(),
      }),
      // maxSeq is the poll cursor: without it a driver re-reads the whole tail
      execute: async ({ scope, limit, sinceSeq, kinds }) => {
        const rows = await viewOf(sessions, projectId, VIEW.timeline, { scope, sinceSeq, kinds, limit: limit ?? 15 }) ?? []
        return { rows, maxSeq: rows.at(-1)?.seq ?? null } // log rows are ascending by seq
      },
    }),
  }

  if (!actions) return read

  const mutate: ToolSet = {
    new_request: tool({
      description: 'Create a new request. The title is a short LABEL; spec carries the actual intent (goal, constraints, outputs) — agents never infer intent from the title. grounded=true makes an agent analyze the repo and propose a decomposition (REQUIRES spec and cwd); otherwise a quick single-step task is created (then propose/approve/run it). workspaceId picks the checkout the request is worked in — it defaults to the workspace this server runs in, so pass one only to target another (workspace_list names them; workspace_new makes one).',
      inputSchema: z.object({
        title: z.string().min(1), spec: z.string().optional(),
        workspaceId: z.string().min(1).optional(),
        grounded: z.object({ modelRef: z.string().min(1), cwd: z.string().min(1) }).optional(),
      }),
      // no budget from a chat tool: a ceiling is an operator decision
      execute: async input => actions.newTask({ ...input, budgetUSD: null }, origin),
    }),
    workspace_list: tool({
      description: 'Workspaces of this project: a checkout, or an orc worktree created for one request, each with its health — state (dangling/waiting/active/idle/merged), when it last saw activity and its task counts. Ordered attention-first. Read-only — project_status lists each workspace\'s tasks.',
      inputSchema: z.object({}),
      execute: async () => actions.listWorkspaces(),
    }),
    workspace_new: tool({
      description: 'Create a git worktree + branch for ONE request under the project\'s .orc/worktrees, record it as a workspace, and draft the request as its first task. Use for a new piece of work; reuse the current workspace for follow-ups to it.',
      inputSchema: z.object({ title: z.string().min(1), spec: z.string().optional(), base: z.string().optional() }),
      execute: async input => actions.newWorkspace(input, origin),
    }),
    [KnowledgeToolName.decisionList]: tool({
      description: 'List every recorded architectural DECISION, attention-first (proposed, accepted, deprecated, then superseded), each with its one-line summary and its supersedes / supersededBy links. An empty list means none are recorded yet. Optionally filter by status.',
      inputSchema: DecisionFilter,
      execute: async input => actions.listDecisions(input, origin),
    }),
    [KnowledgeToolName.decisionRead]: tool({
      description: 'Read one recorded DECISION in full — context, decision, consequences and the options considered — by its id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => actions.readDecision(id, origin),
    }),
    [KnowledgeToolName.recordDecision]: tool({
      description: `Record an architectural DECISION as a file (Context / Decision / Consequences), status accepted unless you say proposed. Before recording, enumerate what exists with ${KnowledgeToolName.decisionList}; to change a recorded decision pass its id as \`supersedes\` — never re-record under the same title (that is refused).`,
      inputSchema: DecisionInput,
      execute: async input => actions.recordDecision(input, origin),
    }),
    propose: tool({
      description: 'Propose a single-step plan for a draft task.',
      inputSchema: z.object({ taskId, modelRef: z.string().min(1), skillRefs: z.array(z.string()).optional() }),
      execute: async ({ taskId: id, modelRef, skillRefs }) => actions.propose(id, { template: { modelRef, skillRefs: skillRefs ?? [] } }, origin),
    }),
    // no approve tool by design: a prompt line is not a gate; groundedApprovalDoors is operator config
    run: tool({
      // cwd is an override: omitted, the run uses the task's own workspace
      description: 'Start the approved plan running in its workspace (or an explicit cwd).',
      inputSchema: z.object({ taskId, cwd: z.string().min(1).optional() }),
      execute: async ({ taskId: id, cwd }) => actions.run(id, cwd ?? null, origin),
    }),
    reply: tool({
      description: 'Answer a task’s open feedback question, resuming the waiting step.',
      inputSchema: z.object({ taskId, text: z.string().min(1) }),
      execute: async ({ taskId: id, text }) => actions.reply(id, text, undefined, origin),
    }),
    retry: tool({
      description: 'Re-run the steps of a BLOCKED task that did not complete (a task in any other status is refused). A task blocked by a rejecting verdict is refused too — the same siblings would be judged the same way; revise the plan instead.',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) => actions.retry(id, null, origin),
    }),
    cancel: tool({
      description: 'Cancel a running/blocked task (terminal). Ask the user first.',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) => actions.cancel(id, origin),
    }),
    annotate: tool({
      description: 'Queue refinement feedback on one plan-note of a grounded decomposition.',
      inputSchema: z.object({ taskId, noteId: z.string().min(1), text: z.string().min(1) }),
      execute: async ({ taskId: id, noteId, text }) => actions.annotate(id, noteId, text, [], origin),
    }),
    revise: tool({
      description: 'Annotate the scoped plan-notes and wake the plan agent to revise them.',
      inputSchema: z.object({ taskId, text: z.string().min(1), scope: z.array(z.string().min(1)).min(1) }),
      execute: async ({ taskId: id, text, scope }) => actions.revise(id, text, scope, origin),
    }),
  }
  return { ...read, ...mutate }
}
