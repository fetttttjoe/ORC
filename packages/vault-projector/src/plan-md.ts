import { isRecord, PlanDraft, type Plan } from '@orc/contracts'
import { frontmatter } from './frontmatter'

const FENCE = '---'

export function renderPlanFile(plan: Plan): string {
  const summary = plan.steps
    .map(s => `- **${s.id}** (${s.role}) — ${s.title} · ${s.executorRef} · ${s.modelRef} · ${s.isolation}`)
    .join('\n')
  return `${frontmatter({
    type: 'plan',
    task: plan.taskId,
    version: plan.version,
    strategyRef: plan.strategyRef,
    costEstimateUSD: plan.costEstimateUSD,
    steps: plan.steps,
  })}\n# Plan v${plan.version}\n\n${summary}\n\n` +
    `> The frontmatter above is authoritative. Edit it, then run \`orc edit ${plan.taskId} --from-vault\` to apply as a new version.\n`
}

export function parsePlanFile(text: string): PlanDraft {
  if (!text.startsWith(`${FENCE}\n`)) throw new Error('plan file missing frontmatter fence')
  const end = text.indexOf(`\n${FENCE}`, FENCE.length)
  if (end === -1) throw new Error('plan file has unclosed frontmatter fence')
  const parsed: unknown = Bun.YAML.parse(text.slice(FENCE.length + 1, end))
  if (!isRecord(parsed)) throw new Error('plan file frontmatter is not a mapping')
  const data = parsed
  return PlanDraft.parse({
    strategyRef: data.strategyRef,
    costEstimateUSD: data.costEstimateUSD ?? null,
    steps: data.steps,
  })
}
