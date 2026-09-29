import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Decision, DecisionStatus, type DecisionDraft, type DecisionWriteResult, type KnowledgeProblem } from '@orc/contracts'
import { planDecisionRecord } from '@orc/knowledge-core'
import { writeAtomic } from './bucket-files'
import type { BucketLocks } from './bucket-lock'
import {
  DECISION_FILE_SUFFIX, decisionFileName, FrontKey, parseDecision, parseDecisionName, renderDecision,
  type DecisionFile, type DecisionLines, type DecisionName,
} from './decision-format'
import { codeOf, Errno } from './error-code'
import { DECISION_HEADINGS } from './headings'
import { README_BUCKET } from './layout'
import { DECISION_PROBLEM } from './problems'

export interface DecisionScan {
  decisions: ReadonlyMap<string, Decision>
  claimed: ReadonlySet<string>
  problems: KnowledgeProblem[]
}
export interface DecisionFiles {
  scan(root: string): DecisionScan
  record(root: string, draft: DecisionDraft): Promise<DecisionWriteResult>
}

type FileCoversDecision = Exclude<keyof Decision, keyof DecisionFile | 'id' | 'date' | 'location'> extends never ? true : never
const fileCoversDecision: FileCoversDecision = true
void fileCoversDecision

const fileOf = (d: Decision): DecisionFile => ({
  title: d.title, status: d.status, tags: d.tags, supersedes: d.supersedes, supersededBy: d.supersededBy,
  context: d.context, decision: d.decision, consequences: d.consequences, considered: d.considered,
})

interface ParsedDecision { decision: Decision; lines: DecisionLines }
interface Candidate { location: string; parsed: ParsedDecision | null }

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(DECISION_FILE_SUFFIX) && entry.name !== README_BUCKET)
      .map(entry => entry.name)
      .sort()
  } catch (err) {
    if (codeOf(err) === Errno.ENOENT) return []
    throw err
  }
}

function readDecision(root: string, location: string, named: DecisionName, problems: KnowledgeProblem[]): ParsedDecision | null {
  const parsed = parseDecision(readFileSync(path.join(root, location), 'utf8'), DECISION_HEADINGS)
  if ('problem' in parsed) {
    problems.push({ location, ...parsed.problem })
    return null
  }
  const decision = Decision.safeParse({ ...parsed.file, id: named.id, date: named.date, location })
  if (decision.success) return { decision: decision.data, lines: parsed.lines }
  const issues = decision.error.issues
  problems.push({
    location,
    line: [...parsed.lines].find(([field]) => field === issues[0].path[0])?.[1] ?? 0,
    message: issues.map(i => (i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`)).join('; '),
  })
  return null
}

function crossChecks(served: ReadonlyMap<string, ParsedDecision>): KnowledgeProblem[] {
  const problems: KnowledgeProblem[] = []
  const unpaired = new Set<string>()
  const at = (d: ParsedDecision, key: FrontKey, message: string): void => {
    problems.push({ location: d.decision.location, line: d.lines.get(key) ?? 0, message })
  }
  const onOneSide = (newer: string, older: ParsedDecision): void => {
    const pair = `${newer}\n${older.decision.id}`
    if (unpaired.has(pair)) return
    unpaired.add(pair)
    at(older, FrontKey.status, DECISION_PROBLEM.notReciprocal(newer, older.decision.id))
  }
  for (const held of served.values()) {
    const d = held.decision
    if ((d.status === DecisionStatus.superseded) !== (d.supersededBy !== null)) at(held, FrontKey.status, DECISION_PROBLEM.statusMismatch(d.id))
    if (d.supersedes !== null) {
      const older = served.get(d.supersedes)
      if (older === undefined) at(held, FrontKey.supersedes, DECISION_PROBLEM.danglingSupersedes(d.id, d.supersedes))
      else if (older.decision.status !== DecisionStatus.superseded || older.decision.supersededBy !== d.id) onOneSide(d.id, older)
    }
    if (d.supersededBy !== null) {
      const newer = served.get(d.supersededBy)
      if (newer === undefined) at(held, FrontKey.supersededBy, DECISION_PROBLEM.danglingSupersededBy(d.id, d.supersededBy))
      else if (newer.decision.supersedes !== d.id) onOneSide(newer.decision.id, held)
    }
  }
  return problems
}

export function createDecisionFiles(decisionsDir: string, locks: BucketLocks): DecisionFiles {
  const locationOf = (name: string): string => path.posix.join(decisionsDir, name)

  const scan = (root: string): DecisionScan => {
    const problems: KnowledgeProblem[] = []
    const byId = new Map<string, Candidate[]>()
    for (const name of namesIn(path.join(root, decisionsDir))) {
      const location = locationOf(name)
      const named = parseDecisionName(name)
      if (named === null) {
        problems.push({ location, line: 0, message: DECISION_PROBLEM.badName(name) })
        continue
      }
      byId.set(named.id, [...(byId.get(named.id) ?? []), { location, parsed: readDecision(root, location, named, problems) }])
    }
    const served = new Map<string, ParsedDecision>()
    for (const [id, candidates] of byId) {
      const [only, ...more] = candidates
      if (more.length === 0) {
        if (only.parsed !== null) served.set(id, only.parsed)
        continue
      }
      for (const c of candidates)
        problems.push({ location: c.location, line: 0, message: DECISION_PROBLEM.duplicate(id, candidates.filter(o => o !== c).map(o => o.location)) })
    }
    problems.push(...crossChecks(served))
    return { decisions: new Map([...served].map(([id, held]) => [id, held.decision])), claimed: new Set(byId.keys()), problems }
  }

  const record = (root: string, draft: DecisionDraft): Promise<DecisionWriteResult> => {
    const dir = path.join(root, decisionsDir)
    const slugs = [draft.id, ...(draft.supersedes === null ? [] : [draft.supersedes])]
    return locks.withLocks(slugs.map(slug => path.join(dir, slug)), async () => {
      const { decisions, claimed } = scan(root)
      const plan = planDecisionRecord({ held: decisions, claimed, draft, locationOf: d => locationOf(decisionFileName(d.date, d.id)) })
      for (const d of plan.writes) writeAtomic(path.join(root, d.location), renderDecision(fileOf(d), DECISION_HEADINGS))
      return plan.result
    })
  }

  return { scan, record }
}
