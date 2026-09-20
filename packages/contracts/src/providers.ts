import { z } from 'zod'
import type { ModelCost, ModelProvider } from './execution'

export const ProviderConfig = z.strictObject({
  plugin: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
})
export type ProviderConfig = z.infer<typeof ProviderConfig>
export const ProviderConfigs = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), ProviderConfig.nullable())
export type ProviderConfigs = z.infer<typeof ProviderConfigs>

export interface ProviderPlugin<LM = unknown> {
  id: string
  create(options: Record<string, unknown>, costs: Record<string, ModelCost>): ModelProvider<LM>
}
