import { z } from 'zod'

/**
 * The node-detail payloads, parsed at the boundary. `/api/node` returns a different shape per node
 * kind and the browser must not guess: each view parses what it needs and degrades to the raw
 * fallback when the shape is unknown, so a server-side change surfaces as "unrecognised", never as
 * a blank pane or a crash.
 */
const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUSD: z.number().nullable(),
  estimated: z.boolean().optional(),
})

export const TaskDetail = z.object({
  task: z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    title: z.string(),
    spec: z.string().optional(),
    status: z.string(),
    zone: z.array(z.string()).optional(),
    budgetUSD: z.number().nullable().optional(),
    depth: z.number().optional(),
    createdAt: z.string().optional(),
  }),
  usage: Usage.nullish(),
  steps: z
    .array(
      z.object({
        stepId: z.string(),
        status: z.string(),
        attempt: z.number().optional(),
        iterations: z.number().optional(),
        usage: Usage.optional(),
        failure: z.object({ class: z.string().optional(), message: z.string() }).nullable().optional(),
      }),
    )
    .default([]),
  artifacts: z.array(z.object({ path: z.string(), size: z.number().optional() })).default([]),
  memoryPulls: z.number().nullish(),
})
export type TaskDetail = z.infer<typeof TaskDetail>

/** just the artifact list, for callers that only need the count (the your-move line) */
export const TaskArtifacts = z.object({ artifacts: z.array(z.object({ path: z.string() })).default([]) })

export const StepDetail = z.object({
  step: z.object({
    id: z.string(),
    role: z.string().optional(),
    title: z.string(),
    instructions: z.string().optional(),
    modelRef: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    zone: z.array(z.string()).optional(),
  }),
  // null, not absent, until the step runs — and the same for its usage
  run: z
    .object({
      status: z.string(),
      attempt: z.number().optional(),
      iterations: z.number().optional(),
      output: z.string().nullish(),
      failure: z.object({ class: z.string().optional(), message: z.string() }).nullish(),
    })
    .nullish(),
  usage: Usage.nullish(),
})
export type StepDetail = z.infer<typeof StepDetail>

export const NoteDetail = z.object({
  note: z.object({
    id: z.string(),
    scope: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).default([]),
    links: z.array(z.object({ id: z.string(), kind: z.string() })).default([]),
    paths: z.array(z.string()).default([]),
    sourceRevision: z.string().optional(),
    categories: z.array(z.string()).default([]),
    tier: z.string().optional(),
    kind: z.string().optional(),
    retention: z.string().optional(),
    sources: z.array(z.string()).default([]),
    // claims are the note's atomic statements and live INSIDE the note — reading them from the
    // envelope root meant they never rendered. Each carries the revision it was recorded at,
    // which is what makes a single stale statement visible inside an otherwise current note.
    claims: z.array(z.object({ id: z.string(), text: z.string(), sourceRevision: z.string().optional() })).default([]),
  }),
  hits: z.number().nullish(),
  // backlinks carry the neighbour's TITLE — rendering the slug threw away the readable half
  backlinks: z.array(z.object({ id: z.string(), scope: z.string().optional(), title: z.string().optional(), kind: z.string() })).default([]),
  author: z.object({ taskId: z.string().nullable().optional() }).optional(),
  invalidates: z.array(z.string()).default([]),
})
export type NoteDetail = z.infer<typeof NoteDetail>

// the artifact record arrives BARE (not wrapped), sized as `size`, and carries no taskId —
// that lives in the node id. Expecting a wrapper made every artifact render as a raw record.
export const ArtifactDetail = z.object({
  path: z.string(),
  size: z.number().optional(),
  sha256: z.string().optional(),
  stepId: z.string().optional(),
  seq: z.number().optional(),
})
export type ArtifactDetail = z.infer<typeof ArtifactDetail>

// `ref` and `totals` sit at the root and each task carries its own usage — the previous shape
// parsed (every field optional) and rendered a bare list with none of the measured spend.
export const ModelDetail = z.object({
  ref: z.string(),
  totals: Usage.nullish(),
  tasks: z
    .array(z.object({ taskId: z.string(), title: z.string().optional(), status: z.string().optional(), calls: z.number().optional(), usage: Usage.nullish() }))
    .default([]),
})
export type ModelDetail = z.infer<typeof ModelDetail>

export const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
