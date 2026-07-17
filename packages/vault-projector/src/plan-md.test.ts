import { describe, expect, it } from 'bun:test'
import { PlanDraft } from '@orc/contracts'
import { draftFixture, planFixture, stepFixture } from '@orc/contracts/fixtures'
import { parsePlanFile, renderPlanFile } from './plan-md'

describe('plan-md round-trip', () => {
  it('parse(render(plan)) equals the draft, including arrays and null cost', () => {
    const plan = planFixture({
      costEstimateUSD: null,
      steps: [
        stepFixture({ id: 's1', dependsOn: [], skillRefs: ['a'], toolRefs: ['srv/tool'] }),
        stepFixture({ id: 's2', dependsOn: ['s1'], skillRefs: [], toolRefs: [] }),
      ],
    })
    const parsed = parsePlanFile(renderPlanFile(plan, 'awaiting_approval'))
    expect(parsed).toEqual(PlanDraft.parse(draftFixture(plan.steps)))
  })

  it('throws on missing frontmatter fence', () => {
    expect(() => parsePlanFile('# no fence')).toThrow()
  })
})
