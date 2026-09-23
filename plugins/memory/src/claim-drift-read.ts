import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { basisAnchors, ClaimDriftState, claimDriftState, DRIFT_STATE, type BlobAt, type ClaimInput, type DriftState, type VerifiedStamp } from '@orc/contracts'
import { createDriftProbe, noteDriftState, type ChangedSince, type CorpusDrift } from './drift'
import { treeStamps } from './tree-stamps'

/** what the judged checkout says each path hashes to; a path it could not judge is ABSENT, never null */
export type BlobsAt = (paths: readonly string[]) => Promise<ReadonlyMap<string, string | null>>

/** the two probes a verdict is read through, so a test can supply either without a repo */
export interface DriftSources {
  changedSince: ChangedSince
  blobsAt: BlobsAt
}

export interface DriftableNote {
  sourceRevision: string | null
  paths?: readonly string[]
  verified?: VerifiedStamp
  claims?: readonly ClaimInput[]
}

export interface NoteDrift {
  state: DriftState
  suspectClaims: string[]
  unknownClaims: string[]
  /** was anything actually compared — a note nothing could be measured against is not \"current\" */
  checkable: boolean
}

// a deletion is reported only when the checkout itself could be read — a failed probe is not a gone file
export function createBlobProbe(dir: string): BlobsAt {
  const stamps = treeStamps(dir)
  const cache = new Map<string, Promise<string | null | undefined>>()
  const observe = async (file: string): Promise<string | null | undefined> => {
    const hash = await stamps.blob(file)
    if (hash !== null) return hash
    const root = await realpath(dir).catch(() => null)
    if (root === null) return undefined
    const full = path.resolve(root, file)
    if (full !== root && !full.startsWith(root + path.sep)) return undefined
    return (await Bun.file(full).exists()) ? undefined : null
  }
  return async paths => {
    const out = new Map<string, string | null>()
    await Promise.all(paths.map(async file => {
      let hit = cache.get(file)
      if (!hit) { hit = observe(file); cache.set(file, hit) }
      const seen = await hit
      if (seen !== undefined) out.set(file, seen)
    }))
    return out
  }
}

/** both probes over ONE checkout — the corpus reads config.dir, a step reads its own workspace */
export const checkoutDrift = (dir: string): DriftSources => ({ changedSince: createDriftProbe(dir), blobsAt: createBlobProbe(dir) })

export async function readNoteDrift(note: DriftableNote, src: DriftSources): Promise<NoteDrift> {
  const claims = note.claims ?? []
  const paths = note.paths ?? []
  if (claims.length === 0) {
    const state = await noteDriftState({ sourceRevision: note.sourceRevision, paths, ...(note.verified && { verified: note.verified }) }, src.changedSince)
    return { state, suspectClaims: [], unknownClaims: [], checkable: note.sourceRevision !== null && paths.length > 0 }
  }
  const verified = note.verified?.claims ?? []
  const bases = claims.map(c => ({ id: c.id, ...basisAnchors(c, verified) }))
  const observed = await src.blobsAt([...new Set(bases.flatMap(b => b.anchors.map(a => a.path)))])
  const blobAt: BlobAt = file => observed.get(file)
  const suspectClaims: string[] = []
  const unknownClaims: string[] = []
  let compared = 0
  for (const claim of bases) {
    const state = claimDriftState(claim, blobAt)
    if (state === ClaimDriftState.suspect) { suspectClaims.push(claim.id); compared += 1 }
    else if (state === ClaimDriftState.unknown) unknownClaims.push(claim.id)
    else if (state === ClaimDriftState.clean) compared += 1
  }
  const state = suspectClaims.length > 0
    ? DRIFT_STATE.drifted
    : compared === 0 && unknownClaims.length > 0 ? DRIFT_STATE.unknown : DRIFT_STATE.clean
  return { state, suspectClaims, unknownClaims, checkable: compared > 0 }
}

export async function readCorpusDrift(notes: readonly DriftableNote[], src: DriftSources): Promise<CorpusDrift> {
  let checkable = 0
  let drifted = 0
  let unknown = 0
  for (const note of notes) {
    const d = await readNoteDrift(note, src)
    if (d.state === DRIFT_STATE.unknown) { unknown += 1; continue }
    if (!d.checkable) continue
    checkable += 1
    if (d.state === DRIFT_STATE.drifted) drifted += 1
  }
  return { checkable, drifted, unknown, total: notes.length, ratio: checkable === 0 ? null : drifted / checkable }
}
