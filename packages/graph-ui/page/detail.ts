// Detail views — compositions of the ui/ primitives, one per node type. Every id is a Link
// through the injected `go` (the ONE navigation entry), so the whole panel is a graph too.
// Input shapes are what ui-core's nodeDetail returns; unknown shapes fall back to raw JSON.
// value import from the browser-safe subpath: the ui-core index pulls in the server-side
// sessions (pg/DBOS) and must never enter the page bundle
import { artifactNodeId, noteNodeId, stepNodeId } from '@orc/ui-core/graph'
import { el } from './ui/el'
import { Badge, Card, Empty, KV, Link, Pre, statusTone } from './ui/components'

interface TaskDetail {
  task: { id: string; title: string; status: string; spec: string; createdAt: string; parentId: string | null }
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUSD: number | null; estimated: boolean }
  steps: Array<{ stepId: string; status: string; iterations: number }>
  artifacts: Array<{ path: string; sha256: string; size: number }>
}
interface StepDetail {
  step: { id: string; title: string; role: string; instructions: string; modelRef: string; maxIterations: number }
  run: { status: string; attempt: number; iterations: number; output: string | null; failure: { class: string; message: string } | null } | null
}
interface NoteDetail {
  note: { id: string; scope: string; title: string; kind: string; summary: string; body: string; tags: string[]; links: Array<{ id: string; kind: string }>; sources: Array<{ url: string; title?: string }>; rules: string[] }
  author: { source: string; taskId?: string | null; model?: string }
  hits: number
  backlinks: Array<{ id: string; scope: string; title: string; kind: string }>
}
interface ArtifactDetail { path: string; sha256: string; size: number; stepId: string | null }

type Go = (node: string) => void

const cost = (u: TaskDetail['usage']): string =>
  u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`

const links = (parts: Array<HTMLElement | string>): HTMLElement => {
  const out = el('span', {})
  parts.forEach((p, i) => { if (i > 0) out.append(' · '); out.append(p) })
  return out
}

export function renderDetail(nodeId: string, d: unknown, go: Go): HTMLElement {
  if (d !== null && typeof d === 'object' && 'task' in d) {
    const t = d as TaskDetail
    return el('div', {},
      Card([t.task.title, Badge(t.task.status, statusTone(t.task.status))],
        KV([
          ['id', t.task.id],
          ...(t.task.parentId ? [['parent', Link(t.task.parentId.slice(0, 8), () => go(t.task.parentId!))] as [string, HTMLElement]] : []),
          ['created', t.task.createdAt],
          ['tokens', `${t.usage.inputTokens} in / ${t.usage.outputTokens} out`],
          ...(t.usage.cacheReadTokens || t.usage.cacheWriteTokens
            ? [['cache r/w', `${t.usage.cacheReadTokens ?? 0} / ${t.usage.cacheWriteTokens ?? 0}`] as [string, string]] : []),
          ['cost', cost(t.usage)],
        ]),
        t.task.spec ? Pre(t.task.spec) : null,
      ),
      t.steps.length
        ? Card([`steps (${t.steps.length})`],
            KV(t.steps.map(s => [s.stepId, links([
              Link(`${s.status} · ${s.iterations} iter`, () => go(stepNodeId(t.task.id, s.stepId))),
            ])] as [string, HTMLElement])))
        : null,
      t.artifacts.length
        ? Card([`artifacts (${t.artifacts.length})`],
            KV(t.artifacts.map(a => [
              '',
              links([Link(a.path, () => go(artifactNodeId(t.task.id, a.path))), `${a.size}B · ${a.sha256.slice(0, 12)}`]),
            ] as [string, HTMLElement])))
        : null,
    )
  }
  if (d !== null && typeof d === 'object' && 'step' in d) {
    const s = d as StepDetail
    const taskId = nodeId.split(':')[1] ?? ''
    return el('div', {}, Card([s.step.title, Badge(s.run?.status ?? 'pending', statusTone(s.run?.status ?? 'pending'))],
      KV([
        ['task', Link(taskId.slice(0, 8), () => go(taskId))],
        ['role', s.step.role],
        ['model', s.step.modelRef],
        ['iterations', `${s.run?.iterations ?? 0} / ${s.step.maxIterations}`],
        ...(s.run?.failure ? [['failure', `[${s.run.failure.class}] ${s.run.failure.message}`] as [string, string]] : []),
      ]),
      Pre(s.step.instructions),
      s.run?.output ? Card(['output'], Pre(s.run.output)) : null,
    ))
  }
  if (d !== null && typeof d === 'object' && 'note' in d) {
    const n = d as NoteDetail
    return el('div', {}, Card([n.note.title, Badge(n.note.kind, 'purple'), Badge(`${n.hits} hits`, 'muted')],
      KV([
        ['id', `${n.note.scope}/${n.note.id}`],
        ['author', n.author.taskId
          ? links([`${n.author.model ?? 'agent'} · `, Link(`task ${n.author.taskId.slice(0, 8)}`, () => go(n.author.taskId!))])
          : n.author.source],
        ...(n.note.tags.length ? [['tags', n.note.tags.join(', ')] as [string, string]] : []),
        ...(n.note.links.length
          ? [['links', links(n.note.links.map(l => Link(`${l.kind} → ${l.id}`, () => go(noteNodeId(n.note.scope, l.id)))))] as [string, HTMLElement]] : []),
        ...(n.backlinks.length
          ? [['linked by', links(n.backlinks.map(b => Link(b.id, () => go(noteNodeId(b.scope, b.id)))))] as [string, HTMLElement]] : []),
      ]),
      n.note.summary ? el('div', {}, n.note.summary) : null,
      n.note.body ? Pre(n.note.body) : null,
      n.note.rules.length ? Card(['rules'], KV(n.note.rules.map((r, i) => [`#${i + 1}`, r]))) : null,
      n.note.sources.length ? Card(['sources'], KV(n.note.sources.map(s => [s.title ?? 'link', s.url]))) : null,
    ))
  }
  if (d !== null && typeof d === 'object' && 'ref' in d && 'totals' in d) {
    const m = d as { ref: string; tasks: Array<{ taskId: string; title: string; status: string; calls: number; usage: { inputTokens: number; outputTokens: number; costUSD: number | null } }>; totals: { inputTokens: number; outputTokens: number; costUSD: number | null } }
    return el('div', {}, Card([m.ref, Badge(`${m.tasks.length} task(s)`, 'accent')],
      KV([
        ['total tokens', `${m.totals.inputTokens} in / ${m.totals.outputTokens} out`],
        ['total cost', m.totals.costUSD === null ? 'n/a' : `$${m.totals.costUSD.toFixed(4)}`],
      ]),
      ...m.tasks.map(t => Card([Link(t.title, () => go(t.taskId)), Badge(t.status, statusTone(t.status))],
        KV([
          ['calls', String(t.calls)],
          ['tokens', `${t.usage.inputTokens} in / ${t.usage.outputTokens} out`],
          ['cost', t.usage.costUSD === null ? 'n/a' : `$${t.usage.costUSD.toFixed(4)}`],
        ]))),
    ))
  }
  if (d !== null && typeof d === 'object' && 'sha256' in d) {
    const a = d as ArtifactDetail
    const taskId = nodeId.split(':')[1] ?? ''
    return el('div', {}, Card([a.path, Badge(`${a.size}B`, 'warn')],
      KV([
        ['sha256', a.sha256],
        ['step', a.stepId ? Link(a.stepId, () => go(stepNodeId(taskId, a.stepId!))) : '?'],
      ])))
  }
  return el('div', {}, d === null ? Empty(`no detail for ${nodeId}`) : Pre(JSON.stringify(d, null, 2)))
}
