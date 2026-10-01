import { extname } from 'node:path'

export enum Grammar {
  typescript = 'typescript',
  tsx = 'tsx',
}

export const GRAMMAR_WASM: Record<Grammar, string> = {
  [Grammar.typescript]: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  [Grammar.tsx]: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
}

const GRAMMAR_BY_EXTENSION: ReadonlyMap<string, Grammar> = new Map([
  ['.ts', Grammar.typescript],
  ['.mts', Grammar.typescript],
  ['.cts', Grammar.typescript],
  ['.js', Grammar.typescript],
  ['.mjs', Grammar.typescript],
  ['.cjs', Grammar.typescript],
  ['.tsx', Grammar.tsx],
  ['.jsx', Grammar.tsx],
])

export const grammarOf = (path: string): Grammar | null => GRAMMAR_BY_EXTENSION.get(extname(path)) ?? null
