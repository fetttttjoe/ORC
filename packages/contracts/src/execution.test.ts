import { describe, expect, it } from 'bun:test'
import { EventKind, PAYLOAD_SCHEMAS } from './events'
import {
  addUsage, classifiedError, costUSDFor, failureClassOf, isTerminalError, resolveModel, terminalError,
  Signal, UnifiedEvent, FAILURE_CLASS, SIGNAL_OUTCOME, type ModelProvider, type Usage,
} from './execution'

const usage = (i: number, o: number, cost: number | null = null, estimated = false): Usage =>
  ({ inputTokens: i, outputTokens: o, costUSD: cost, estimated })

describe('execution contracts', () => {
  it('has a payload schema for every event kind (incl. the 8 new ones)', () => {
    expect(EventKind.options).toContain('run_started')
    expect(EventKind.options).toContain('step_failed')
    for (const kind of EventKind.options) expect(PAYLOAD_SCHEMAS[kind]).toBeDefined()
  })

  it('step_failed payload requires a failure class', () => {
    expect(() => PAYLOAD_SCHEMAS.step_failed.parse({ stepId: 's', runToken: 'r', message: 'x' })).toThrow()
    expect(PAYLOAD_SCHEMAS.step_failed.parse({
      stepId: 's', runToken: 'r', class: FAILURE_CLASS.agent_error, message: 'x',
    })).toBeTruthy()
  })

  it('UnifiedEvent discriminates on type', () => {
    const ev = UnifiedEvent.parse({
      type: 'signal',
      signal: { stepId: 's1', runToken: 'rt', outcome: SIGNAL_OUTCOME.success, summary: 'done' },
    })
    expect(ev.type).toBe('signal')
    expect(() => UnifiedEvent.parse({ type: 'nope' })).toThrow()
  })

  it('addUsage sums defensively and taints estimates', () => {
    const sum = addUsage(usage(10, 5, 0.01), usage(1, 1, null, true))
    expect(sum.inputTokens).toBe(11)
    expect(sum.costUSD).toBe(0.01)
    expect(sum.estimated).toBe(true)
  })

  it('costUSDFor uses exact model, wildcard, then null', () => {
    const costs = { 'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 } }
    expect(costUSDFor(costs, 'claude-sonnet-5', 1_000_000, 1_000_000)).toBe(18)
    expect(costUSDFor(costs, 'unknown-model', 1000, 1000)).toBeNull()
    expect(costUSDFor({ '*': { inPerMTok: 0, outPerMTok: 0 } }, 'llama3', 5000, 5000)).toBe(0)
  })

  it('resolveModel splits on the first slash and errors on unknown providers', () => {
    const fake: ModelProvider<string> = { costs: {}, languageModel: id => `LM:${id}` }
    const providers = new Map([['ollama', fake]])
    const r = resolveModel(providers, 'ollama/library/llama3')
    expect(r.modelId).toBe('library/llama3')
    expect(r.model).toBe('LM:library/llama3')
    expect(() => resolveModel(providers, 'nope/m')).toThrow(/unknown provider/)
  })

  it('Signal rejects an empty summary', () => {
    expect(() => Signal.parse({ stepId: 's', runToken: 'r', outcome: 'success', summary: '' })).toThrow()
  })

  it('terminalError marks an error the retry protocol must not re-run', () => {
    expect(isTerminalError(terminalError('bad api key'))).toBe(true)
    expect(isTerminalError(new Error('flaky network'))).toBe(false)
    expect(isTerminalError(undefined)).toBe(false)
  })

  it('classifiedError is terminal and carries its class', () => {
    const err = classifiedError(FAILURE_CLASS.validation_error, 'bad ref')
    expect(isTerminalError(err)).toBe(true)
    expect(failureClassOf(err)).toBe(FAILURE_CLASS.validation_error)
    expect(failureClassOf(new Error('plain'))).toBeNull()
    expect(failureClassOf({ failureClass: 'not-a-class' })).toBeNull()
  })
})
