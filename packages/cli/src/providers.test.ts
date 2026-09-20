import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { loadConfig } from '@orc/kernel'
import { seedRegistries } from './runtime'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function configured(settings: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'orc-providers-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.orc'))
  writeFileSync(join(dir, '.orc/config.json'), JSON.stringify(settings))
  return loadConfig(dir)
}

test('a provider added only in config is available to the runtime with its own costs', () => {
  const costs = { model: { inPerMTok: 1, outPerMTok: 2 } }
  const config = configured({
    providers: { alternate: { plugin: 'openai', options: { baseUrl: 'https://example.test/v1', apiKeyEnv: 'ALTERNATE_KEY' } } },
    costOverrides: { alternate: costs },
  })
  const { providers } = seedRegistries(config)
  expect([...providers.keys()].sort()).toEqual(['alternate', 'anthropic', 'ollama', 'openai'])
  const alternate = providers.get('alternate')
  expect(alternate?.costs).toEqual(costs)
  expect(z.object({ modelId: z.string() }).parse(alternate?.languageModel('model')).modelId).toBe('model')
})

test('config can replace or disable a default provider without editing registrations', () => {
  const { providers } = seedRegistries(configured({
    providers: { anthropic: null, ollama: null, openai: { plugin: 'openai', options: { preset: 'codex' } } },
  }))
  expect([...providers.keys()]).toEqual(['openai'])
})

test('unknown plugins and invalid plugin options fail before a plan can run', () => {
  expect(() => seedRegistries(configured({ providers: { broken: { plugin: 'missing' } } }))).toThrow("unknown provider plugin 'missing'")
  expect(() => seedRegistries(configured({ providers: { broken: { plugin: 'openai', options: { baseUrl: 'not-a-url' } } } }))).toThrow()
  expect(() => seedRegistries(configured({ providers: { broken: { plugin: 'openai', options: { baseURL: 'https://example.test' } } } }))).toThrow()
})
