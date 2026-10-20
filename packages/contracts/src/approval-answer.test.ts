import { describe, expect, it } from 'bun:test'
import { APPROVAL_ANSWER, ApprovalAnswer, isApprovalAnswer } from './approval-answer'

describe('isApprovalAnswer', () => {
  it('accepts every word in the set, and the canonical word the UI button sends', () => {
    for (const w of Object.values(ApprovalAnswer)) expect(isApprovalAnswer(w)).toBe(true)
    // the cross-process property: whatever the button sends, the kernel gate must accept
    expect(isApprovalAnswer(APPROVAL_ANSWER)).toBe(true)
  })

  it('accepts "agree" — the answer that was silently ignored and cost a round-trip', () => {
    expect(isApprovalAnswer('agree')).toBe(true)
    expect(isApprovalAnswer('agreed')).toBe(true)
  })

  it('trims and case-folds exactly as the old literal comparison did', () => {
    expect(isApprovalAnswer('  Approve \n')).toBe(true)
    expect(isApprovalAnswer('APPROVE')).toBe(true)
    expect(isApprovalAnswer('LGTM')).toBe(true)
  })

  it('rejects refusals, hedges, and anything that merely CONTAINS an approval word', () => {
    for (const t of [
      'no', 'nope', 'reject', 'deny', 'not yet',
      "don't approve", 'do not approve', 'approve later', 'unapprove', 'disapprove', 'approve?',
      'approve the second step only', 'i agree with the concern about step 3',
      '', '   ', 'n', 'maybe', 'looks good but change step 2',
    ]) expect(isApprovalAnswer(t)).toBe(false)
  })

  it('rejects a bare "y" — a single stray keystroke must not approve a run', () => {
    expect(isApprovalAnswer('y')).toBe(false)
  })
})
