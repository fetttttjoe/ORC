import { z } from 'zod'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const DEFAULT_KNOWLEDGE_DIR = 'knowledge'
export const DEFAULT_MANIFESTS: readonly string[] = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'mix.exs',
]

export const GitFilesOptions = z.strictObject({
  dirName: z.string().regex(NAME).default(DEFAULT_KNOWLEDGE_DIR),
  manifests: z.array(z.string().regex(NAME)).min(1).default([...DEFAULT_MANIFESTS]),
})
export type GitFilesOptions = z.infer<typeof GitFilesOptions>
