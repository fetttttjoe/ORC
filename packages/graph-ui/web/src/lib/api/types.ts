// wire shapes of /api — the app depends on the HTTP contract, not server internals.
//
// Every shape here is INFERRED from the schema that parses it. A hand-written second copy drifts:
// an envelope declaring `patch` required where the schema made it optional was a build error, and
// `authorTaskId`, `copilotModel` and `analyzerRef` existed on the wire but were invisible to every
// consumer because no interface mentioned them. A field can only reach a component by being parsed first.
import type { z } from 'zod'
import type * as S from './schemas'
import type { KnowledgeHealth } from '@orc/contracts/health'
import type { GraphNode as WireNode, GraphLink as WireLink, GraphPatch as WirePatch } from '@orc/ui-core/graph-wire'

// Graph shapes come from ui-core's zero-import wire module: ONE declaration, so a field rename
// on the projection side fails this build instead of silently producing dead edges.
export type { GraphNode, GraphLink, GraphPatch } from '@orc/ui-core/graph-wire'

/**
 * ui-core's wire module parses what its graph-wire module declares. graph-wire takes no imports
 * (the browser must not drag the projection's dependencies in through it), so the two cannot be
 * one declaration — these guards are the substitute, and they live HERE because this build is the
 * one with `exactOptionalPropertyTypes` on: widen or rename either side and it fails here rather
 * than in a pane that renders nothing.
 *
 * TWO guards, because `Exact` alone has a hole that cost us a field. Mutual assignability holds in
 * BOTH directions when one side gains an OPTIONAL property — a value lacking it is assignable to
 * the type that declares it optional, and the extra key is not rejected by assignability either —
 * so when the wire's task node gained `workspaceId?`, this file still compiled while the parser
 * below STRIPPED the field out of every node the browser reads. That is exactly the "a new field
 * could be silently dropped" case, so it gets a guard that fails the build rather than a review
 * that might catch it: `SameKeys` compares `keyof`, which counts optional keys, so a property on
 * one side and not the other is now an error.
 *
 * What each still owns: `Exact` catches a field whose TYPE diverges (a widened union of node
 * types); `SameKeys` catches a field added or removed on either side. Neither can see
 * a schema whose RUNTIME parse is narrower than the type it infers — `z.string().min(1)` and
 * `z.string()` both infer `string` — so a rejected-at-parse value stays a runtime concern.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never
const _healthMatchesContract: Exact<z.infer<typeof S.Health>['knowledge'], KnowledgeHealth | null> = true
const _nodeMatchesWire: Exact<z.infer<typeof S.GraphSnapshot>['nodes'][number], WireNode> = true
const _linkMatchesWire: Exact<z.infer<typeof S.GraphSnapshot>['links'][number], WireLink> = true
const _patchMatchesWire: Exact<NonNullable<z.infer<typeof S.Envelope>['patch']>, WirePatch> = true
const _nodeKeysMatchWire: SameKeys<z.infer<typeof S.GraphSnapshot>['nodes'][number], WireNode> = true
const _linkKeysMatchWire: SameKeys<z.infer<typeof S.GraphSnapshot>['links'][number], WireLink> = true
const _patchKeysMatchWire: SameKeys<NonNullable<z.infer<typeof S.Envelope>['patch']>, WirePatch> = true
void _healthMatchesContract
void _nodeMatchesWire
void _linkMatchesWire
void _patchMatchesWire
void _nodeKeysMatchWire
void _linkKeysMatchWire
void _patchKeysMatchWire

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
