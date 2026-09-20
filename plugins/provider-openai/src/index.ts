import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import { z } from 'zod'
import { modelIdsFrom, type ModelCost, type ModelProvider, type ProviderPlugin } from '@orc/contracts'
import { credentialHeaders } from './auth'
import { OPENAI_PLUGIN_ID, OpenAIApi, openAIOptions, type OpenAIOptions } from './options'
import { providerFetch, type ProviderFetch } from './transport'

export const providerPlugin: ProviderPlugin<LanguageModel> = {
  id: OPENAI_PLUGIN_ID,
  create: (options, costs) => createOpenAIProvider(costs, options),
}

const Catalog = z.record(z.string(), z.unknown())
const ModelRows = z.array(z.record(z.string(), z.unknown()))

async function discoverModels(options: OpenAIOptions, fetchImpl: ProviderFetch): Promise<string[]> {
  const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}${options.models.path}`, {
    headers: await credentialHeaders(options),
  })
  if (!response.ok) throw new Error(`openai ${options.models.path} answered ${response.status}`)
  const body = Catalog.parse(await response.json())
  const filter = options.models.filter
  if (filter) body[options.models.listKey] = ModelRows.parse(body[options.models.listKey]).filter(row => row[filter.key] === filter.value)
  return modelIdsFrom(body, options.models.listKey, options.models.idKey)
}

export async function listOpenAIModels(fetchImpl: ProviderFetch = fetch): Promise<string[]> {
  return discoverModels(openAIOptions(), fetchImpl)
}

export function createOpenAIProvider(
  costOverrides: Record<string, ModelCost> = {},
  input: unknown = {},
  fetchImpl: ProviderFetch = fetch,
): ModelProvider<LanguageModel> {
  const options = openAIOptions(input)
  const openai = createOpenAI({ baseURL: options.baseUrl, apiKey: 'resolved-by-provider-transport', fetch: providerFetch(options, fetchImpl) })
  return {
    costs: { ...costOverrides },
    languageModel: modelId => wrapLanguageModel({
      model: options.api === OpenAIApi.chat ? openai.chat(modelId) : openai.responses(modelId),
      middleware: {
        transformParams: async ({ params }) => ({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            [OPENAI_PLUGIN_ID]: { ...params.providerOptions?.[OPENAI_PLUGIN_ID], ...options.providerOptions },
          },
        }),
      },
    }),
    listModels: () => discoverModels(options, fetchImpl),
  }
}
