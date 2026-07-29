import { describe, it, expect } from 'bun:test'
import { STEP_ID, STEP_ROLE } from '@orc/contracts'
import { agentAnalyzer } from './index'

describe('agentAnalyzer', () => {
  it('produces the plan-grounding scout step (codebase-analysis, writes fenced by the kernel)', () => {
    const s = agentAnalyzer().analysisStep({ modelRef: 'p/m', taskSpec: 'x' })
    expect(s.id).toBe(STEP_ID.analyze)
    expect(s.role).toBe(STEP_ROLE.scout)
    expect(s.skillRefs).toEqual(['codebase-analysis'])
    expect(s.readOnlySource).toBeUndefined() // the analyze step's write-fence is set by the kernel
  })
})
