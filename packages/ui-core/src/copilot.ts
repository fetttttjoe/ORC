// The copilot: an AI-SDK agent whose tools are the SAME read APIs and OrcActions the UI uses —
// it can never bypass the action layer, and every call it makes is streamed to the client as a
// visible card. Transport-free: the web server (or a TUI) supplies the model and runs the loop.
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
import type { MemoryHealth, ResolvedTool, SupervisorHealth, WorkspaceWithHealth } from '@orc/contracts'
import { DecisionFilter, DecisionInput, errorMessage, EventKind, groupByWorkspace, KnowledgeToolName, MEMORY_HEALTH, toolError, type Origin } from '@orc/contracts'

// Why a session can't act: 'read-only' = server started outside a project; 'foreign-project'
// = the user is viewing a chat other than the one this server runs in.
export type CopilotMode = 'act' | 'read-only' | 'foreign-project'

const MODE_LINES: Record<CopilotMode, string> = {
  act: `You may execute actions (create requests, propose, run, reply, refine plans). Plan approval is HUMAN-ONLY — you have no approve tool: present the plan (steps, models, dependencies), then point the user at the approve button in the request view or \`orc approve <taskId>\`. Confirm with the user before cancel. Prefer grounded requests for repo work (the agent analyzes the codebase first); quick requests for simple one-shot jobs. After acting, state what you did and what happens next.`,
  'read-only': `This session is read-only: explain state and suggest the CLI commands the user could run.`,
  'foreign-project': `This chat is READ-ONLY: actions run only in the project chat where orc graph was started. If the user wants to act, tell them to switch to that chat — or restart orc graph from this project's directory.`,
}

// The selection in the user's own words, so "run this" resolves to the pane they are reading
// rather than to whatever task the model last saw in a tool result.
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

// Door #2 bridge (P7): the SAME toolset the web copilot uses, reshaped for any ResolvedTool
// consumer — the MCP server today, a TUI tomorrow. One tool definition, two doors: zod
// schemas become JSON Schema natively (zod v4), execute wraps into {output, isError}.
export function asResolvedTools(tools: ToolSet): ResolvedTool[] {
  return Object.entries(tools).map(([name, t]) => {
    const schema = t.inputSchema as z.ZodType
    const { $schema: _drop, ...inputSchema } = z.toJSONSchema(schema)
    return {
      ref: `orc/${name}`, name,
      description: typeof t.description === 'string' ? t.description : name, // ai v7 allows fn descriptions; ours are strings
      inputSchema: inputSchema as Record<string, unknown>,
      execute: async (input: unknown) => {
        // On the web door the ai SDK safeParses against inputSchema before this execute ever
        // runs; the MCP door calls this execute directly with raw client JSON. Every mutating
        // tool below destructures assuming parsed args (e.g. run's `{ taskId: id, cwd }`) — a
        // numeric taskId or object cwd from an MCP client reached actions.run unvalidated.
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
  // Exactly the two reads this door performs: every grounded answer comes through `model` (the
  // view registry reads it) and the graph snapshot project_status counts. Narrow on purpose —
  // a composition without a full session store can still serve these tools.
  sessions: Pick<ProjectSessions, 'model' | 'snapshot'>
  actions: OrcActions | null
  projectId: string
  // The EXCHANGE this toolset serves: every mutation below is stamped with it, so the events a
  // copilot call appends are readable as one conversation rather than as anonymous door traffic.
  origin: Origin
  listModels?: () => Promise<string[]>
  // The project's workspaces for project_status, wired from the kernel exactly as listModels is.
  // Optional for the same reason health is: a composition without a project context has none, and
  // an empty list would read as "this project has no workspaces" — which is never true, since every
  // task belongs to one. Absent means the field is OMITTED.
  listWorkspaces?: () => Promise<readonly WorkspaceWithHealth[]>
  // Read-model health for project_status (same probe graph-ui's /api/health serves). Optional
  // because not every composition has a memory plugin; absent means the field is OMITTED — a
  // fabricated "ok" would tell a driver the graph is current while it is mid-rebuild, which is
  // how a rebuilding read model stayed invisible at this door on 2026-08-01 (operators had to
  // read SurrealDB/Postgres directly to learn why nothing was running).
  health?: () => Promise<{ memory: MemoryHealth; supervisor?: SupervisorHealth }>
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
      description: 'List every request (task) in this project with its status, the workspaces (checkouts) they are worked in, plus graph counts and memory (read model) health. Start here.',
      inputSchema: z.object({}),
      execute: async () => {
        const { graph } = await sessions.snapshot(projectId)
        // A failed lookup OMITS the field, the same posture the health probe below holds and for
        // the same reason: this is the tool a driver starts from, and one optional dep must never
        // take the whole answer down. Omission, not `[]` — an empty list reads as "this project has
        // no workspaces", which is never true.
        const workspaces = await listWorkspaces?.().catch(() => undefined)
        // Typed against NodeType rather than free-floating: this was the fourth hand-spelled copy
        // of the node vocabulary, and a kind added to the wire counted as undefined here. Still
        // written out — Record<NodeType, number> makes a MISSING key a compile error, which is the
        // guarantee wanted, and building it from the tuple would need a cast on the seed object.
        const counts: Record<NodeType, number> = { task: 0, step: 0, artifact: 0, note: 0, model: 0 }
        for (const n of graph.nodes) counts[n.type]++
        // a failed probe reports unreachable-with-reason (graph-ui's /api/health posture) —
        // health must never take project_status down with it, and never read as silently ok
        const h = health
          ? await health()
            .catch((err: unknown) => ({ memory: { state: MEMORY_HEALTH.unreachable, pending: 0, reason: errorMessage(err) } }))
          : undefined
        const tasks = graph.nodes.filter(n => n.type === 'task')
        // groupByWorkspace requires a required workspaceId; GraphNode's stays `| undefined` because
        // the field is wire-shared across all five node kinds, so the predicate narrows here rather
        // than asserting one. Computed once, outside the return, so every workspace entry below
        // reads its slice off ONE grouping pass instead of re-filtering `tasks` per workspace.
        const byWorkspace = workspaces && new Map(
          groupByWorkspace(
            workspaces.map(w => w.workspace),
            tasks.filter((n): n is GraphNode & { workspaceId: string } => n.workspaceId !== undefined),
          ).map(g => [g.workspace.id, g.items]),
        )
        return {
          tasks: tasks.map(n => ({ taskId: n.id, title: n.label, status: n.detail })),
          counts,
          // Grouped from the task list this call ALREADY has, not from a second fold: the snapshot's
          // task nodes carry their workspaceId. `tasks` above still lists every task whatever its
          // workspace, because two kinds of task fall into no group here and BOTH have to stay
          // visible: one whose workspace record the log never recorded (an orphan — a log defect),
          // and one whose workspace was ARCHIVED, which listWorkspaces filters out while the task
          // itself is still perfectly real.
          ...(workspaces && {
            workspaces: workspaces.map(({ workspace: w, health }) => ({
              id: w.id, title: w.title, kind: w.kind, branch: w.branch, cwd: w.cwd,
              taskIds: (byWorkspace?.get(w.id) ?? []).map(n => n.id),
              // Passed through WHOLE, never re-derived and never narrowed here: this is the same
              // verdict `orc ws ls` and workspace_list carry, and a door that summarized it into its
              // own words would be a fourth reading of "is this checkout still going anywhere".
              health,
            })),
          }),
          ...(h && { memory: h.memory }),
          // "is anything driving?" — a driver seeing every task idle needs this before anything else
          ...(h && 'supervisor' in h && h.supervisor && { supervisor: h.supervisor }),
        }
      },
    }),
    task_plan: tool({
      description: 'Read a task’s plan versions (steps, models, dependencies) and which version is approved.',
      // Derived, not re-spelled: this tool's input IS the plans view's params, and a door whose
      // schema drifts from the view it reads asks for a field the read will not honour.
      inputSchema: WIRE[VIEW.plans].params,
      // `visual` is rebuilt field-by-field rather than spread: this is an ALLOWLIST, so a field
      // added to the plans view for the browser's benefit cannot silently start costing model
      // tokens on every call. It caught exactly that once — visual.mermaid was a diagram
      // serialization for a renderer, re-telling the model what `waves` already says. That field is
      // gone, which makes the projection an identity TODAY; it stays because the next one will not.
      execute: async ({ taskId: id }) => {
        const plans = await viewOf(sessions, projectId, VIEW.plans, { taskId: id })
        if (!plans) return { error: 'no plan proposed yet' }
        const { visual, ...rest } = plans
        return { ...rest, ...(visual && { visual: { version: visual.version, waves: visual.waves } }) }
      },
    }),
    task_transcript: tool({
      description: 'Read a task’s agent conversation (messages, tool calls, questions, signal). Recent items only; tool payloads are truncated — read an artifact or the file itself for the full text.',
      // The transcript view's params plus this door's own bound. The limit is NOT the view's:
      // a model reads 50 items at most because it pays per token, while a pane scrolls thousands.
      inputSchema: WIRE[VIEW.transcript].params.extend({ limit: z.number().int().min(1).max(50).optional() }),
      // Every payload is bounded because an unbounded one is not a readable answer: one single
      // tool result came back as 88KB through this door, burying the conversation it was meant
      // to explain. Tool input/output become snipped STRINGS (they are arbitrary JSON — a
      // file read, a search hit list); messages keep their existing text snip. QUESTIONS AND
      // SIGNALS PASS THROUGH VERBATIM: a driver has to answer the exact question that was asked
      // and read the exact summary that was signalled — a truncated one is a wrong one.
      execute: async ({ taskId: id, stepId, limit }) =>
        (await viewOf(sessions, projectId, VIEW.transcript, { taskId: id, stepId }) ?? []).slice(-(limit ?? 30)).map(i =>
          i.kind === 'message' ? { ...i, text: snip(i.text, 400) }
          : i.kind === 'tool' ? { ...i, input: snip(JSON.stringify(i.input), 400), output: snip(JSON.stringify(i.output), 400) }
          : i),
    }),
    plan_notes: tool({
      description: 'Read a grounded task’s decomposition plan-notes (the split-up: subplans, dependencies, zones, skills/tools, models, uncertainty).',
      inputSchema: WIRE[VIEW.planNotes].params,
      // The mechanics — subplans and dependsOn (what orders the frozen plan), zone (the write
      // fence), skillRefs/toolRefs/modelRef — are what a driver has to see to judge or revise a
      // decomposition; mapping only the prose left it reviewing a plan it could not read.
      // modelRef is conditional: '' means "inherit the parent's", and an empty string reads as a
      // model choice that was made.
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
      // The timeline view's params, narrowed to what a model should hold: no beforeSeq (paging
      // backward is a scrollback gesture, not a driver's question) and a limit of 50 rather than
      // the view's 1000, because this door's rows are paid for per token. Everything else — the
      // scope, the seq cursor, the event vocabulary behind `kinds` — is the view's own schema, so
      // this door cannot ask for a field the read will not honour, and `scope` stays REQUIRED here
      // for the reason it is required there: a default would silently pick one of two questions.
      inputSchema: WIRE[VIEW.timeline].params.pick({ scope: true, sinceSeq: true, kinds: true }).extend({
        limit: z.number().int().min(1).max(50).optional(),
      }),
      // maxSeq is the poll cursor: without one a driver had no way to ask "what happened since?"
      // and re-read the whole tail every time, paying for (and re-reasoning about) rows it had
      // already seen.
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
      // no budget from a chat tool: a ceiling is an operator decision, and a model inventing one
      // silently capped runs the human never agreed to
      execute: async input => actions.newTask({ ...input, budgetUSD: null }, origin),
    }),
    workspace_list: tool({
      description: 'Workspaces of this project: a checkout, or an orc worktree created for one request, each with its health — state (dangling/waiting/active/idle/merged), when it last saw activity, its task counts and how many notes it holds that are still pending a merge. Ordered attention-first. Read-only — project_status lists each workspace\'s tasks.',
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
    // no `approve` tool by design: the human gate is structural — a prompt line is not a gate
    // (observed live: create→propose→approve→run in 600ms with no human in the loop). The one
    // deliberate exception is operator-owned, not prompt-owned: groundedApprovalDoors in
    // .orc/config.json can add 'mcp' to the sources the grounded gate accepts — a config-file
    // edit the operator makes, which no tool here can perform.
    run: tool({
      // cwd is the OVERRIDE, not the instruction: omitted, the run happens in the task's own
      // workspace (the kernel resolves it from the record). Naming a directory for every run is how
      // a task created in one worktree gets driven from another checkout.
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
      description: 'Cancel a running/blocked task (terminal; sweeps its orphaned notes). Ask the user first.',
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
