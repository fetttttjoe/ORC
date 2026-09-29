import { z } from 'zod'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SEGMENT_SEPARATOR = '/'
export const DEFAULT_KNOWLEDGE_DIR = 'knowledge'
export const DEFAULT_DECISIONS_DIR = 'docs/decisions'
export const DEFAULT_MANIFESTS: readonly string[] = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'mix.exs',
]

export const OPTIONS_REFUSAL = {
  decisionsPath: (): string => 'decisionsDir is a relative path of plain folder names',
  decisionsInKnowledge: (dirName: string): string => `decisionsDir may not sit inside a '${dirName}' folder`,
} as const

const segmentsOf = (dir: string): string[] => dir.split(SEGMENT_SEPARATOR)

const GitFilesFields = z.strictObject({
  dirName: z.string().regex(NAME).default(DEFAULT_KNOWLEDGE_DIR),
  manifests: z.array(z.string().regex(NAME)).min(1).default([...DEFAULT_MANIFESTS]),
  decisionsDir: z.string().refine(dir => segmentsOf(dir).every(s => NAME.test(s)), OPTIONS_REFUSAL.decisionsPath()).default(DEFAULT_DECISIONS_DIR),
})
const FIELD = GitFilesFields.keyof().enum

export const GitFilesOptions = GitFilesFields.check(ctx => {
  if (segmentsOf(ctx.value.decisionsDir).includes(ctx.value.dirName))
    ctx.issues.push({ code: 'custom', input: ctx.value, path: [FIELD.decisionsDir], message: OPTIONS_REFUSAL.decisionsInKnowledge(ctx.value.dirName) })
})
export type GitFilesOptions = z.infer<typeof GitFilesOptions>
