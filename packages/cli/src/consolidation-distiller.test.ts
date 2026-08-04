import { describe, expect, it } from 'bun:test'
import { distillPrompt } from './consolidation-distiller'

describe('distillPrompt', () => {
  const base = { taskId: 't-distil', taskTitle: 'Add a subcommand', steps: [{ title: 'plan', summary: 'three subplans: implement, test, verify' }], derivedFrom: [] }

  // The note this prevents: "implemented, with test coverage and requirement verification" for a run
  // whose test step crashed and whose verify step never started. The step summary described a PLAN.
  it('tells the model the work is incomplete, naming the sub-tasks that did not finish', () => {
    const p = distillPrompt({ ...base, unfinished: ['t.plan.a', 't.plan.b'] })
    expect(p).toContain('NOT complete')
    expect(p).toContain('t.plan.a, t.plan.b')
    expect(p).toContain('Do NOT state that anything was implemented, tested or verified')
  })

  it('says nothing about completion when the whole subtree finished', () => {
    const p = distillPrompt({ ...base, unfinished: [] })
    expect(p).not.toContain('NOT complete')
    expect(p).toContain('never restate it as completed') // the standing rule still applies
  })
})
