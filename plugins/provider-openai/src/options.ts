import { z } from 'zod'

export enum OpenAIAuth { apiKey = 'apikey', codex = 'codex', none = 'none' }
export enum OpenAIApi { responses = 'responses', chat = 'chat' }
export const OPENAI_PLUGIN_ID = 'openai'
export const CODEX_PRESET = 'codex'

const ModelDiscovery = z.strictObject({
  path: z.string().startsWith('/').default('/models'),
  listKey: z.string().min(1).default('data'),
  idKey: z.string().min(1).default('id'),
  filter: z.strictObject({ key: z.string(), value: z.string() }).optional(),
})

const Options = z.strictObject({
  preset: z.string().optional(),
  baseUrl: z.url().default('https://api.openai.com/v1'),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('OPENAI_API_KEY'),
  auth: z.enum(OpenAIAuth).default(OpenAIAuth.apiKey),
  codexHome: z.string().min(1).optional(),
  api: z.enum(OpenAIApi).default(OpenAIApi.responses),
  models: ModelDiscovery.prefault({}),
  providerOptions: z.record(z.string(), z.json()).default({}),
  streamOnly: z.boolean().default(false),
  omitRequestFields: z.array(z.string().min(1)).default([]),
})
export type OpenAIOptions = z.infer<typeof Options>

export const PRESETS: Readonly<Record<string, z.input<typeof Options>>> = {
  [CODEX_PRESET]: {
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    auth: OpenAIAuth.codex,
    models: { path: '/models?client_version=0.153.4', listKey: 'models', idKey: 'slug', filter: { key: 'visibility', value: 'list' } },
    providerOptions: { store: false, instructions: '' },
    streamOnly: true,
    omitRequestFields: ['max_output_tokens', 'temperature', 'top_p'],
  },
}

export function openAIOptions(input: unknown = {}): OpenAIOptions {
  const supplied = z.object({
    preset: z.string().optional(),
    models: z.record(z.string(), z.unknown()).optional(),
    providerOptions: z.record(z.string(), z.json()).optional(),
  }).loose().parse(input)
  const preset = supplied.preset === undefined ? {} : PRESETS[supplied.preset]
  if (!preset) throw new Error(`unknown OpenAI provider preset '${supplied.preset}'`)
  return Options.parse({
    ...preset, ...supplied,
    models: { ...preset.models, ...supplied.models },
    providerOptions: { ...preset.providerOptions, ...supplied.providerOptions },
  })
}
