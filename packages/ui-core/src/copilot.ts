// The copilot: an AI-SDK agent whose tools are the SAME read APIs and OrcActions the UI uses —
// it can never bypass the action layer, and every call it makes is streamed to the client as a
// visible card. Transport-free: the web server (or a TUI) supplies the model and runs the loop.
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'

const snip = (s: string, n = 400): string => (s.length > n ? s.slice(0, n) + '…' : s)

export function copilotSystemPrompt(projectName: string, canAct: boolean): string {
  return [
    `You are the orc copilot for the project "${projectName}" — a guide through a multi-agent orchestrator.`,
    `Requests (tasks) move through: draft → plan proposed → approved (human gate) → running steps → done, with verified output artifacts and a growing knowledge graph of memory notes.`,
    `Ground every answer in tool reads — never invent task ids, statuses, or content. Read before you act.`,
    canAct
      ? `You may execute actions (create requests, propose, approve, run, reply, refine plans). Confirm with the user before cancel. Prefer grounded requests for repo work (the agent analyzes the codebase first); quick requests for simple one-shot jobs. After acting, state what you did and what happens next.`
      : `This session is read-only: explain state and suggest the CLI commands the user could run.`,
    `Be concise. When the user is unsure, propose a concrete next move.`,
  ].join('\n')
}

export function buildCopilotTools(deps: {
  sessions: ProjectSessions
  actions: OrcActions | null
  projectId: string
}): ToolSet {
  const { sessions, actions, projectId } = deps
  const taskId = z.string().min(1)

  const read: ToolSet = {
    project_status: tool({
      description: 'List every request (task) in this project with its status, plus graph counts. Start here.',
      inputSchema: z.object({}),
      execute: async () => {
        const { graph } = await sessions.snapshot(projectId)
        const counts = { task: 0, step: 0, artifact: 0, note: 0 }
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
          i.kind === 'message' ? { ...i, text: snip(i.text) } : i),
    }),
    plan_notes: tool({
      description: 'Read a grounded task’s decomposition plan-notes (the split-up: subplans, dependencies, uncertainty).',
      inputSchema: z.object({ taskId }),
      execute: async ({ taskId: id }) =>
        (await sessions.planNotes(projectId, id)).notes.map(n => ({
          id: n.id, title: n.title, summary: snip(n.summary), rationale: snip(n.rationale),
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
      description: 'Create a new request. grounded=true makes an agent analyze the repo and propose a decomposition (needs cwd); otherwise a quick single-step task is created (then propose/approve/run it).',
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
    approve: tool({
      description: 'Approve the latest plan (the human gate) — only after the user agreed.',
      inputSchema: z.object({ taskId, version: z.number().int().positive().optional() }),
      execute: async ({ taskId: id, version }) => actions.approve(id, version),
    }),
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
