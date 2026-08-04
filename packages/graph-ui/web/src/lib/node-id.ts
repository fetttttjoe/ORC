// Pure node-id parsers, zero imports by design (the cluster.ts shape): graph node ids are
// `step:<task>:<step>` / `artifact:<task>:<path>` / `note:<key>` / `model:<ref>`, and a bare id
// is a task. Artifact paths and model refs may themselves contain ':', so only the first two
// separators are structural — everything after them belongs to the last part.
export type NodeKind = 'task' | 'step' | 'artifact' | 'note' | 'model'

/** build a step node id — the inverse of stepIdOf, so the two spellings cannot drift */
export const stepNodeId = (taskId: string, stepId: string): string => `step:${taskId}:${stepId}`

/** build a note node id; the projection keys notes by scope + NUL + id (ui-core's noteKey) */
export const noteNodeId = (scope: string, id: string): string => `note:${scope}\u0000${id}`

const PREFIXED = ['step', 'artifact', 'note', 'model'] as const
const SEP = ':'

/** kind from the id's prefix; unprefixed ids default to task */
export const nodeKind = (id: string): NodeKind => PREFIXED.find(k => id.startsWith(`${k}${SEP}`)) ?? 'task'

/** the owning task id, or null for kinds (note, model) that no single task owns */
export const taskIdOf = (id: string): string | null => {
  const kind = nodeKind(id)
  if (kind === 'task') return id
  if (kind !== 'step' && kind !== 'artifact') return null
  const task = id.split(SEP)[1]
  return task ? task : null
}

/** the step id from `step:<task>:<step>`, or null for anything else */
export const stepIdOf = (id: string): string | null => {
  if (nodeKind(id) !== 'step') return null
  const step = id.split(SEP).slice(2).join(SEP)
  return step === '' ? null : step
}
