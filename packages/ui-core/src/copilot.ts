// The copilot: an AI-SDK agent whose tools are the SAME read APIs and OrcActions the UI uses —
// it can never bypass the action layer, and every call it makes is streamed to the client as a
// visible card. Transport-free: the web server (or a TUI) supplies the model and runs the loop.
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'

import { snip } from './summarize'
import type { ResolvedTool } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'

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
    const { $schema: _drop, ...inputSchema } = z.toJSONSchema(t.inputSchema as z.ZodType)
    return {
      ref: `orc/${name}`, name,
      description: typeof t.description === 'string' ? t.description : name, // ai v7 allows fn descriptions; ours are strings
      inputSchema: inputSchema as Record<string, unknown>,
      execute: async (input: unknown) => {
        try {
          const out = await (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(
            input ?? {}, { toolCallId: 'mcp', messages: [] })
          return { output: out, isError: false }
        } catch (err) {
          return { output: { error: errorMessage(err) }, isError: true }
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
}): ToolSet {
  const { sessions, actions, projectId, listModels } = deps
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
      description: 'List every request (task) in this project with its status, plus graph counts. Start here.',
      inputSchema: z.object({}),
      execute: async () => {
        const { graph } = await sessions.snapshot(projectId)
        const counts = { task: 0, step: 0, artifact: 0, note: 0, model: 0 }
        for (const n of graph.nodes) counts[n.type]++
        return {
          tasks: graph.nodes.filter(n => n.type === 'task').map(n => ({ taskId: n.id, title: n.label, status: n.detail })),
          counts,
        }
      },
    }),
    task_plan: tool({
      description: 'Read a task’s plan versions (steps, models, dependencies) and which version is approved.',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) => (await sessions.taskPlans(projectId, id)) ?? { error: 'no plan proposed yet' },
    }),
    task_transcript: tool({
      description: 'Read a task’s agent conversation (messages, tool calls, questions, signal). Recent items only.',
      inputSchema: z.object({ taskId, stepId: z.string().optional() }),
      execute: async ({ taskId: id, stepId }) =>
        (await sessions.transcript(projectId, id, stepId)).slice(-30).map(i =>
          i.kind === 'message' ? { ...i, text: snip(i.text, 400) } : i),
    }),
    plan_notes: tool({
      description: 'Read a grounded task’s decomposition plan-notes (the split-up: subplans, dependencies, uncertainty).',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) =>
        (await sessions.planNotes(projectId, id)).notes.map(n => ({
          id: n.id, title: n.title, summary: snip(n.summary, 400), rationale: snip(n.rationale, 400),
          uncertainty: n.uncertainty, links: n.links,
        })),
    }),
    recent_activity: tool({
      description: 'The latest events in this project (one line each) — what just happened.',
      inputSchema: z.object({ taskId: taskId.optional(), limit: z.number().int().min(1).max(50).optional() }),
      execute: async ({ taskId: id, limit }) => sessions.log(projectId, { taskId: id, limit: limit ?? 15 }),
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
    // (observed live: create→propose→approve→run in 600ms with no human in the loop)
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
