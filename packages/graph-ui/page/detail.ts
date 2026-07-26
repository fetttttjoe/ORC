// Detail views — compositions of the ui/ primitives, one per node type. Every id is a Link
// through the injected `go` (the ONE navigation entry), so the whole panel is a graph too.
// Input shapes are what ui-core's nodeDetail returns; unknown shapes fall back to raw JSON.
// value import from the browser-safe subpath: the ui-core index pulls in the server-side
// sessions (pg/DBOS) and must never enter the page bundle
import { artifactNodeId, noteNodeId, stepNodeId } from '@orc/ui-core/graph'
import type { NoteAuthoringDraft, NoteRef } from '@orc/contracts'
import { el } from './ui/el'
import { Badge, Btn, Card, Empty, KV, Link, openDialog, Pre, statusTone } from './ui/components'
import { type MemoryNote, noteLabel, type NoteView, formatLinkSpec, parseLinkSpec } from '@orc/contracts'

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
// `note` is the contract's own shape, not a hand-copied one. The copy this replaces declared
// `kind`, `claims` and `sources` as always-present, which stopped being true when notes split into
// tiers — so opening a plan or episodic note read `.length` off undefined and killed the view.
interface NoteDetail {
  note: MemoryNote
  author: { source: string; taskId?: string | null; model?: string }
  hits: number
  backlinks: Array<{ id: string; scope: string; title: string; kind: string }>
}
interface ArtifactDetail { path: string; sha256: string; size: number; stepId: string | null }

// Capabilities the shell injects when the viewer may mutate (canAct). Detail views render the
// dialogs; the SHELL owns the effects (api call, toast, navigation) — the same inversion as
// `go`, so detail.ts stays a pure composition of ui/ primitives with no api import. null =
// read-only viewer: the buttons simply don't render.
export interface NoteDetailActions {
  write(note: NoteAuthoringDraft): Promise<void>
  remove(ref: NoteRef): Promise<void>
}

type Go = (node: string) => void

const cost = (u: TaskDetail['usage']): string =>
  u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`

const links = (parts: Array<HTMLElement | string>): HTMLElement => {
  const out = el('span', {})
  parts.forEach((p, i) => { if (i > 0) out.append(' · '); out.append(p) })
  return out
}

export function renderDetail(nodeId: string, d: unknown, go: Go, notes?: NoteDetailActions | null): HTMLElement {
  if (d !== null && typeof d === 'object' && 'task' in d) {
    const t = d as TaskDetail
    const parentId = t.task.parentId
    return el('div', {},
      Card([t.task.title, Badge(t.task.status, statusTone(t.task.status))],
        KV([
          ['id', t.task.id],
          ...(parentId ? [['parent', Link(parentId.slice(0, 8), () => go(parentId))] as [string, HTMLElement]] : []),
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
    const note = n.note
    // core fields are guaranteed by the note itself; the tier-specific ones are read through the
    // shared view, which is what makes their absence explicit instead of a crash
    const tierFields: NoteView = note
    const authorTaskId = n.author.taskId
    return el('div', {}, Card([note.title, Badge(noteLabel(note), 'purple'), Badge(`${n.hits} hits`, 'muted')],
      KV([
        ['id', `${note.scope}/${note.id}`],
        ['author', authorTaskId
          ? links([`${n.author.model ?? 'agent'} · `, Link(`task ${authorTaskId.slice(0, 8)}`, () => go(authorTaskId))])
          : n.author.source],
        ...(note.tags.length ? [['tags', note.tags.join(', ')] as [string, string]] : []),
        ...(note.links.length
          ? [['links', links(note.links.map(l => Link(`${l.kind} → ${l.id}`, () => go(noteNodeId(note.scope, l.id)))))] as [string, HTMLElement]] : []),
        ...(n.backlinks.length
          ? [['linked by', links(n.backlinks.map(b => Link(b.id, () => go(noteNodeId(b.scope, b.id)))))] as [string, HTMLElement]] : []),
      ]),
      note.summary ? el('div', {}, note.summary) : null,
      note.body ? Pre(note.body) : null,
      // keyed by claim id, not position: the id is the handle `invalidates` takes, and a positional
      // label would shift under every retirement — which is exactly what content-hashed ids avoid
      tierFields.claims?.length ? Card(['claims'], KV(tierFields.claims.map(c => [c.id, c.text]))) : null,
      tierFields.sources?.length ? Card(['sources'], KV(tierFields.sources.map(s => [s.title ?? 'link', s.url]))) : null,
    ),
      ...(notes && note.scope === 'project' ? [el('div', { class: 'row-split' },
        Btn('edit', () => openDialog(`edit '${note.id}'`, [
          { name: 'title', label: 'title', value: note.title },
          { name: 'summary', label: 'summary', value: note.summary },
          { name: 'body', label: 'body', kind: 'textarea', value: note.body },
          { name: 'tags', label: 'tags', value: note.tags.join(', ') },
          { name: 'links', label: 'links (kind:note-id, …)', value: formatLinkSpec(note.links) },
        ], 'save', async v => {
          if (!v.title?.trim()) throw new Error('title is required')
          // explicit ''/[] (not omission): an emptied field is an intentional CLEAR —
          // the gateway treats omission as keep, empties as clear
          await notes.write({
            id: n.note.id, title: v.title.trim(),
            summary: v.summary ?? '', body: v.body ?? '',
            tags: (v.tags ?? '').split(',').map(t => t.trim()).filter(Boolean),
            links: parseLinkSpec(v.links ?? ''),
          })
        }), 'muted'),
        Btn('delete', () => openDialog(`delete '${n.note.id}' — the content stays in the event log`, [
          { name: 'confirm', label: `type '${n.note.id}' to confirm`, placeholder: n.note.id },
        ], 'delete', async v => {
          if (v.confirm !== n.note.id) throw new Error('id does not match — not deleting')
          await notes.remove({ id: n.note.id, scope: n.note.scope })
        }), 'danger'),
      )] : []),
    )
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
    const stepId = a.stepId
    return el('div', {}, Card([a.path, Badge(`${a.size}B`, 'warn')],
      KV([
        ['sha256', a.sha256],
        ['step', stepId ? Link(stepId, () => go(stepNodeId(taskId, stepId))) : '?'],
      ])))
  }
  return el('div', {}, d === null ? Empty(`no detail for ${nodeId}`) : Pre(JSON.stringify(d, null, 2)))
}
