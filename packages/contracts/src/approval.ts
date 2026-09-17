import { z } from 'zod'

export const ApprovalMode = z.enum(['auto', 'manual'])
export const APPROVAL_MODE = ApprovalMode.enum

export const ApprovalRule = z.object({
  maxDepth: z.number().int().positive().optional(),
  maxCostUSD: z.number().positive().optional(),
  type: z.string().optional(),
  then: ApprovalMode,
})
export type ApprovalRule = z.infer<typeof ApprovalRule>

export const ApprovalPolicy = z.object({
  default: ApprovalMode.default('manual'),
  rules: z.array(ApprovalRule).default([]),
})
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>

// First matching rule wins; a rule matches only if EVERY present field matches.
// A null costEstimateUSD NEVER matches a maxCostUSD rule (treated as unbounded — spec D8).
export function evaluateApproval(
  policy: ApprovalPolicy,
  ctx: { depth: number; costEstimateUSD: number | null; type: string },
): { then: 'auto' | 'manual'; ruleIndex?: number } {
  for (const [i, r] of policy.rules.entries()) {
    if (r.maxDepth !== undefined && ctx.depth > r.maxDepth) continue
    if (r.maxCostUSD !== undefined && (ctx.costEstimateUSD === null || ctx.costEstimateUSD > r.maxCostUSD)) continue
    if (r.type !== undefined && r.type !== ctx.type) continue
    return { then: r.then, ruleIndex: i }
  }
  return { then: policy.default }
}
