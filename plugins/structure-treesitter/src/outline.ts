import { sha256, type Outline, type StructureProvider, type SymbolSpan } from '@orc/contracts'
import { Language, Parser, type Node } from 'web-tree-sitter'
import { Grammar, GRAMMAR_WASM, grammarOf } from './grammars'

enum Syntax {
  function_declaration = 'function_declaration',
  generator_function_declaration = 'generator_function_declaration',
  class_declaration = 'class_declaration',
  abstract_class_declaration = 'abstract_class_declaration',
  interface_declaration = 'interface_declaration',
  type_alias_declaration = 'type_alias_declaration',
  enum_declaration = 'enum_declaration',
  method_definition = 'method_definition',
  method_signature = 'method_signature',
  property_signature = 'property_signature',
  public_field_definition = 'public_field_definition',
  variable_declarator = 'variable_declarator',
  internal_module = 'internal_module',
  module = 'module',
  pair = 'pair',
  identifier = 'identifier',
  type_identifier = 'type_identifier',
  property_identifier = 'property_identifier',
  private_property_identifier = 'private_property_identifier',
  string = 'string',
  arrow_function = 'arrow_function',
  function_expression = 'function_expression',
  object = 'object',
  export_statement = 'export_statement',
  comment = 'comment',
}

enum Field {
  name = 'name',
  key = 'key',
  value = 'value',
}

const NAMED_KINDS: ReadonlySet<string> = new Set([
  Syntax.function_declaration, Syntax.generator_function_declaration, Syntax.class_declaration,
  Syntax.abstract_class_declaration, Syntax.interface_declaration, Syntax.type_alias_declaration,
  Syntax.enum_declaration, Syntax.method_definition, Syntax.method_signature, Syntax.property_signature,
  Syntax.public_field_definition, Syntax.variable_declarator, Syntax.internal_module, Syntax.module, Syntax.pair,
])

const NAME_TYPES: ReadonlySet<string> = new Set([
  Syntax.identifier, Syntax.type_identifier, Syntax.property_identifier, Syntax.private_property_identifier,
  Syntax.string,
])

const PAIR_VALUE_TYPES: ReadonlySet<string> = new Set([Syntax.arrow_function, Syntax.function_expression, Syntax.object])

type Parsers = Record<Grammar, Parser>

const parserFor = async (grammar: Grammar): Promise<Parser> =>
  new Parser().setLanguage(await Language.load(new URL(import.meta.resolve(GRAMMAR_WASM[grammar]))))

const loadParsers = async (): Promise<Parsers> => {
  await Parser.init()
  return { [Grammar.typescript]: await parserFor(Grammar.typescript), [Grammar.tsx]: await parserFor(Grammar.tsx) }
}

let parsers: Promise<Parsers> | null = null

const pairKey = (pair: Node): Node | null => {
  const value = pair.childForFieldName(Field.value)
  return value !== null && PAIR_VALUE_TYPES.has(value.type) ? pair.childForFieldName(Field.key) : null
}

const definedName = (node: Node): string | null => {
  if (!NAMED_KINDS.has(node.type)) return null
  const name = node.type === Syntax.pair ? pairKey(node) : node.childForFieldName(Field.name)
  if (name === null || !NAME_TYPES.has(name.type)) return null
  return name.type === Syntax.string ? name.text.slice(1, -1) : name.text
}

const spanOf = (node: Node): Node => {
  const statement = node.type === Syntax.variable_declarator ? node.parent?.parent : null
  return statement?.type === Syntax.export_statement ? statement : node
}

const tokensOf = (node: Node, tokens: string[]): string[] => {
  if (node.type === Syntax.comment) return tokens
  if (node.childCount === 0) tokens.push(node.text)
  else for (const child of node.children) tokensOf(child, tokens)
  return tokens
}

const digestOf = (node: Node): string => sha256(tokensOf(node, []).join(' '))

const symbolsOf = (node: Node, chain: readonly string[], symbols: SymbolSpan[]): SymbolSpan[] => {
  const name = definedName(node)
  const inner = name === null ? chain : [...chain, name]
  if (name !== null) {
    const span = spanOf(node)
    symbols.push({
      name: inner.join('.'), kind: node.type,
      startLine: span.startPosition.row + 1, endLine: span.endPosition.row + 1, digest: digestOf(span),
    })
  }
  for (const child of node.namedChildren) symbolsOf(child, inner, symbols)
  return symbols
}

const outlineWith = (parser: Parser, source: string): Outline | null => {
  const tree = parser.parse(source)
  if (tree === null) return null
  try {
    const root = tree.rootNode
    return { digest: digestOf(root), symbols: symbolsOf(root, [], []), partial: root.hasError }
  } finally {
    tree.delete()
  }
}

export const createTreeSitterStructure = (): StructureProvider => ({
  async outline(source, path) {
    const grammar = grammarOf(path)
    if (grammar === null) return null
    parsers ??= loadParsers()
    return outlineWith((await parsers)[grammar], source)
  },
})
