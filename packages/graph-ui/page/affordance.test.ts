import { describe, expect, it } from 'bun:test'
import { REPLY_AFFORDANCE, replyAffordance } from './affordance'

describe('replyAffordance', () => {
  it('offers the answer box when this UI may act on the project', () => {
    expect(replyAffordance(true, 't1')).toEqual({ kind: REPLY_AFFORDANCE.box })
  })

  it('offers the command when it may not — a question with no route to answering it is a dead end', () => {
    expect(replyAffordance(false, 't1'))
      .toEqual({ kind: REPLY_AFFORDANCE.command, cmd: 'orc reply t1 "<your answer>"' })
  })
})
