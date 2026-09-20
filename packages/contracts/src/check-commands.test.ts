import { describe, expect, it } from 'bun:test'
import { checkCommandsOf, displayInstructions } from './check-commands'
import { CHECKS_STEP_ID } from './step-ids'

describe('checkCommandsOf', () => {
  it('reads a JSON list of commands', () => expect(checkCommandsOf('["bun test a.ts","bun run typecheck"]')).toEqual(['bun test a.ts', 'bun run typecheck']))
  it.each(['bun run typecheck', '{"a":1}', '["ok", 3]', '[""]'])('answers null for anything else: %s', text => expect(checkCommandsOf(text)).toBeNull())
})

describe('displayInstructions', () => {
  it('shows the checks step as one command per line', () =>
    expect(displayInstructions({ id: CHECKS_STEP_ID, instructions: '["bun test a.ts","bun run typecheck"]' })).toBe('$ bun test a.ts\n$ bun run typecheck'))
  it('leaves every other step, and an unreadable checks step, as written', () => {
    expect(displayInstructions({ id: 's1', instructions: '["not","commands"]' })).toBe('["not","commands"]')
    expect(displayInstructions({ id: CHECKS_STEP_ID, instructions: 'bun run typecheck' })).toBe('bun run typecheck')
  })
})
