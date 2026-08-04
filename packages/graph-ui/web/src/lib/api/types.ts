// wire shapes of /api — the app depends on the HTTP contract, not server internals.
//
// Every shape here is INFERRED from the schema that parses it. Hand-writing them a second time is
// what this file used to do, and the two copies drifted: the envelope declared `patch` required
// where the schema made it optional (a build error), and `authorTaskId`, `copilotModel` and
// `analyzerRef` existed on the wire but were invisible to every consumer because no interface
// mentioned them. A field can now only reach a component by being parsed first.
import type { z } from 'zod'
import type * as S from './schemas'
import type { GraphNode as WireNode, GraphLink as WireLink, GraphPatch as WirePatch } from '@orc/ui-core/graph-wire'

// Graph shapes come from ui-core's zero-import wire module: ONE declaration, so a field rename
// on the projection side fails this build instead of silently producing dead edges.
export type { GraphNode, GraphLink, GraphPatch } from '@orc/ui-core/graph-wire'

/**
 * The graph schemas in schemas.ts parse what graph-wire.ts declares. graph-wire takes no imports
 * (the browser must not drag the projection's dependencies in through it), so the two cannot be
 * one declaration — these guards are the substitute: widen or rename either side and the build
 * fails here rather than in a pane that renders nothing.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _nodeMatchesWire: Exact<z.infer<typeof S.GraphSnapshot>['nodes'][number], WireNode> = true
const _linkMatchesWire: Exact<z.infer<typeof S.GraphSnapshot>['links'][number], WireLink> = true
const _patchMatchesWire: Exact<NonNullable<z.infer<typeof S.Envelope>['patch']>, WirePatch> = true
void _nodeMatchesWire
void _linkMatchesWire
void _patchMatchesWire

export type GraphSnapshot = z.infer<typeof S.GraphSnapshot>
export type LogRow = z.infer<typeof S.LogRows>[number]
export type Envelope = z.infer<typeof S.Envelope>
export type ProjectEntry = z.infer<typeof S.ProjectList>[number]
export type Health = z.infer<typeof S.Health>
export type SessionInfo = z.infer<typeof S.SessionInfo>

export type PlansView = z.infer<typeof S.PlansView>
export type PlanVersionView = PlansView['versions'][number]
export type PlanStepView = PlanVersionView['steps'][number]
export type WaveStep = NonNullable<PlansView['visual']>['waves'][number]['steps'][number]

export type PlanNotesView = z.infer<typeof S.PlanNotesView>
export type PlanNoteView = PlanNotesView['notes'][number]

/**
 * A UNION, not a bag of optionals: a question carries `question`/`answer`, a signal carries
 * `outcome`/`summary`, and a tool's input/output are arbitrary JSON. Flattening it once made
 * questions render blank and objects render as "[object Object]".
 */
export type TranscriptItem = z.infer<typeof S.Transcript>[number]

export type NodeDetail = Record<string, unknown>
