// The copilot: an AI-SDK agent whose tools are the SAME read APIs and OrcActions the UI uses —
// it can never bypass the action layer, and every call it makes is streamed to the client as a
// visible card. Transport-free: the web server (or a TUI) supplies the model and runs the loop.
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'

import { snip } from './summarize'
import type { MemoryHealth, ResolvedTool, SupervisorHealth } from '@orc/contracts'
import { errorMessage, EventKind, MEMORY_HEALTH, toolError } from '@orc/contracts'

// Why a session can't act: 'read-only' = server started outside a project; 'foreign-project'
// = the user is viewing a chat other than the one this server runs in.
export type CopilotMode = 'act' | 'read-only' | 'foreign-project'

const MODE_LINES: Record<CopilotMode, string> = {
  act: `You may execute actions (create requests, propose, run, reply, refine plans). Plan approval is HUMAN-ONLY — you have no approve tool: present the plan (steps, models, dependencies), then point the user at the approve button in the request view or \`orc approve <taskId>\`. Confirm with the user before cancel. Prefer grounded requests for repo work (the agent analyzes the codebase first); quick requests for simple one-shot jobs. After acting, state what you did and what happens next.`,
  'read-only': `This session is read-only: explain state and suggest the CLI commands the user could run.`,
  'foreign-project': `This chat is READ-ONLY: actions run only in the project chat where orc graph was started. If the user wants to act, tell them to switch to that chat — or restart orc graph from this project's directory.`,
}

export function copilotSystemPrompt(projectName: string, mode: CopilotMode, defaultCwd?: string): string {
  return [
    `You are the orc copilot for the project "${projectName}" — a guide through a multi-agent orchestrator.`,
    `Requests (tasks) move through: draft → plan proposed → approved (human gate) → running steps → done, with verified output artifacts and a growing knowledge graph of memory notes.`,
    `Ground every answer in tool reads — never invent task ids, statuses, or content. Read before you act.`,
    `Model refs have the form provider/model (e.g. anthropic/…). Call available_models before choosing one — never guess a ref.`,
    MODE_LINES[mode],
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
  sessions: ProjectSessions
  actions: OrcActions | null
  projectId: string
  listModels?: () => Promise<string[]>
  // Read-model health for project_status (same probe graph-ui's /api/health serves). Optional
  // because not every composition has a memory plugin; absent means the field is OMITTED — a
  // fabricated "ok" would tell a driver the graph is current while it is mid-rebuild, which is
  // how a rebuilding read model stayed invisible at this door on 2026-08-01 (operators had to
  // read SurrealDB/Postgres directly to learn why nothing was running).
  health?: () => Promise<{ memory: MemoryHealth; supervisor?: SupervisorHealth }>
}): ToolSet {
  const { sessions, actions, projectId, listModels, health } = deps
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
      description: 'List every request (task) in this project with its status, plus graph counts and memory (read model) health. Start here.',
      inputSchema: z.object({}),
      execute: async () => {
        const { graph } = await sessions.snapshot(projectId)
        const counts = { task: 0, step: 0, artifact: 0, note: 0, model: 0 }
        for (const n of graph.nodes) counts[n.type]++
        // a failed probe reports unreachable-with-reason (graph-ui's /api/health posture) —
        // health must never take project_status down with it, and never read as silently ok
        const h = health
          ? await health()
            .catch((err: unknown) => ({ memory: { state: MEMORY_HEALTH.unreachable, pending: 0, reason: errorMessage(err) } }))
          : undefined
        return {
          tasks: graph.nodes.filter(n => n.type === 'task').map(n => ({ taskId: n.id, title: n.label, status: n.detail })),
          counts,
          ...(h && { memory: h.memory }),
          // "is anything driving?" — a driver seeing every task idle needs this before anything else
          ...(h && 'supervisor' in h && h.supervisor && { supervisor: h.supervisor }),
        }
      },
    }),
    task_plan: tool({
      description: 'Read a task’s plan versions (steps, models, dependencies) and which version is approved.',
      inputSchema: z.object({ taskId }),
      // visual.mermaid is projected AWAY (plan_notes' field-by-field precedent): it is a diagram
      // serialization for the browser renderer, and passing it through was the only cross-surface
      // consumer of the mermaid TEXT — tokens spent re-telling the model what `waves` already says
      execute: async ({ taskId: id }) => {
        const plans = await sessions.taskPlans(projectId, id)
        if (!plans) return { error: 'no plan proposed yet' }
        const { visual, ...rest } = plans
        return { ...rest, ...(visual && { visual: { version: visual.version, waves: visual.waves } }) }
      },
    }),
    task_transcript: tool({
      description: 'Read a task’s agent conversation (messages, tool calls, questions, signal). Recent items only; tool payloads are truncated — read an artifact or the file itself for the full text.',
      inputSchema: z.object({ taskId, stepId: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      // Every payload is bounded because an unbounded one is not a readable answer: one single
      // tool result came back as 88KB through this door, burying the conversation it was meant
      // to explain. Tool input/output become snipped STRINGS (they are arbitrary JSON — a
      // file read, a search hit list); messages keep their existing text snip. QUESTIONS AND
      // SIGNALS PASS THROUGH VERBATIM: a driver has to answer the exact question that was asked
      // and read the exact summary that was signalled — a truncated one is a wrong one.
      execute: async ({ taskId: id, stepId, limit }) =>
        (await sessions.transcript(projectId, id, stepId)).slice(-(limit ?? 30)).map(i =>
          i.kind === 'message' ? { ...i, text: snip(i.text, 400) }
          : i.kind === 'tool' ? { ...i, input: snip(JSON.stringify(i.input), 400), output: snip(JSON.stringify(i.output), 400) }
          : i),
    }),
    plan_notes: tool({
      description: 'Read a grounded task’s decomposition plan-notes (the split-up: subplans, dependencies, zones, skills/tools, models, uncertainty).',
      inputSchema: z.object({ taskId }),
      // The mechanics — dependsOn (the ONLY thing that orders the frozen plan), zone (the write
      // fence), skillRefs/toolRefs/modelRef — are what a driver has to see to judge or revise a
      // decomposition; mapping only the prose left it reviewing a plan it could not read.
      // modelRef is conditional: '' means "inherit the parent's", and an empty string reads as a
      // model choice that was made.
      execute: async ({ taskId: id }) =>
        (await sessions.planNotes(projectId, id)).notes.map(n => ({
          id: n.id, title: n.title, summary: snip(n.summary, 400), rationale: snip(n.rationale, 400),
          body: snip(n.body, 400), uncertainty: n.uncertainty, links: n.links,
          dependsOn: n.dependsOn, zone: n.zone, skillRefs: n.skillRefs, toolRefs: n.toolRefs,
          ...(n.modelRef ? { modelRef: n.modelRef } : {}),
        })),
    }),
    recent_activity: tool({
      description: 'The latest events in this project (one line each) — what just happened. Pass the previous call’s maxSeq as sinceSeq to read only what is new, and kinds to watch specific event kinds.',
      inputSchema: z.object({
        taskId: taskId.optional(), limit: z.number().int().min(1).max(50).optional(),
        sinceSeq: z.number().int().nonnegative().optional(),
        // the event vocabulary itself, never hand-typed kind strings
        kinds: z.array(EventKind).optional(),
      }),
      // maxSeq is the poll cursor: without one a driver had no way to ask "what happened since?"
      // and re-read the whole tail every time, paying for (and re-reasoning about) rows it had
      // already seen. sinceSeq/kinds are spread conditionally — an explicit `undefined` field is
      // not a no-op for a caller that checks `'sinceSeq' in opts`.
      execute: async ({ taskId: id, limit, sinceSeq, kinds }) => {
        const rows = await sessions.log(projectId, {
          taskId: id, limit: limit ?? 15,
          ...(sinceSeq !== undefined && { sinceSeq }), ...(kinds && { kinds }),
        })
        return { rows, maxSeq: rows.at(-1)?.seq ?? null } // log rows are ascending by seq
      },
    }),
  }

  if (!actions) return read

  const mutate: ToolSet = {
    new_request: tool({
      description: 'Create a new request. The title is a short LABEL; spec carries the actual intent (goal, constraints, outputs) — agents never infer intent from the title. grounded=true makes an agent analyze the repo and propose a decomposition (REQUIRES spec and cwd); otherwise a quick single-step task is created (then propose/approve/run it).',
      inputSchema: z.object({
        title: z.string().min(1), spec: z.string().optional(),
        grounded: z.object({ modelRef: z.string().min(1), cwd: z.string().min(1) }).optional(),
      }),
      execute: async input => actions.newTask(input),
    }),
    propose: tool({
      description: 'Propose a single-step plan for a draft task.',
      inputSchema: z.object({ taskId, modelRef: z.string().min(1), skillRefs: z.array(z.string()).optional() }),
      execute: async ({ taskId: id, ...opts }) => actions.propose(id, opts),
    }),
    // no `approve` tool by design: the human gate is structural — a prompt line is not a gate
    // (observed live: create→propose→approve→run in 600ms with no human in the loop). The one
    // deliberate exception is operator-owned, not prompt-owned: groundedApprovalDoors in
    // .orc/config.json can add 'mcp' to the sources the grounded gate accepts — a config-file
    // edit the operator makes, which no tool here can perform.
    run: tool({
      description: 'Start the approved plan running in the given working directory.',
      inputSchema: z.object({ taskId, cwd: z.string().min(1) }),
      execute: async ({ taskId: id, cwd }) => actions.run(id, cwd),
    }),
    reply: tool({
      description: 'Answer a task’s open feedback question, resuming the waiting step.',
      inputSchema: z.object({ taskId, text: z.string().min(1) }),
      execute: async ({ taskId: id, text }) => actions.reply(id, text),
    }),
    retry: tool({
      description: 'Retry a failed run.',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) => actions.retry(id),
    }),
    cancel: tool({
      description: 'Cancel a running/blocked task (terminal; sweeps its orphaned notes). Ask the user first.',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) => actions.cancel(id),
    }),
    annotate: tool({
      description: 'Queue refinement feedback on one plan-note of a grounded decomposition.',
      inputSchema: z.object({ taskId, noteId: z.string().min(1), text: z.string().min(1) }),
      execute: async ({ taskId: id, noteId, text }) => actions.annotate(id, noteId, text),
    }),
    revise: tool({
      description: 'Annotate the scoped plan-notes and wake the plan agent to revise them.',
      inputSchema: z.object({ taskId, text: z.string().min(1), scope: z.array(z.string().min(1)).min(1) }),
      execute: async ({ taskId: id, text, scope }) => actions.revise(id, text, scope),
    }),
  }
  return { ...read, ...mutate }
}
