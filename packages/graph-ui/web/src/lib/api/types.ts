// Every shape is INFERRED from the schema that parses it; a hand-written copy drifts
import type { z } from 'zod'
import type * as S from './schemas'
import type { KnowledgeHealth } from '@orc/contracts/health'
import type { GraphNode as WireNode, GraphLink as WireLink, GraphPatch as WirePatch } from '@orc/ui-core/graph-wire'

// ONE declaration in ui-core's zero-import wire module, so a rename fails this build
export type { GraphNode, GraphLink, GraphPatch } from '@orc/ui-core/graph-wire'

// Exact misses an added optional key, so SameKeys compares keyof too; both fail the build here
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
