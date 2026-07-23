import { LINK_KINDS, LinkKind, MEMORY_ID_RE } from '@orc/contracts'

// The dialogs' link shorthand: comma-separated entries, each 'kind:target-id' or a bare
// 'target-id' (kind omitted — the schema boundary defaults it to relates_to). Throws a friendly
// error naming the bad entry — surfaced inside the dialog like every other field validation.
export function parseLinkSpec(input: string): Array<{ id: string; kind?: LinkKind }> {
  return input
    .split(',')
    .map(e => e.trim())
    .filter(e => e.length > 0)
    .map(entry => {
      const sep = entry.indexOf(':')
      const kind = sep === -1 ? undefined : entry.slice(0, sep).trim()
      const id = (sep === -1 ? entry : entry.slice(sep + 1)).trim()
      if (kind !== undefined && !(LINK_KINDS as readonly string[]).includes(kind))
        throw new Error(`unknown link kind '${kind}' in '${entry}' — valid: ${LINK_KINDS.join(', ')}`)
      if (!MEMORY_ID_RE.test(id))
        throw new Error(`'${id}' is not a valid note id (lowercase letters/digits/dashes)`)
      // the includes-check above guarantees this parse cannot throw (boundary-parse, never cast)
      return kind === undefined ? { id } : { id, kind: LinkKind.parse(kind) }
    })
}

// Inverse, for pre-filling the edit dialog: 'supersedes:old-note, relates_to:other'.
export const formatLinkSpec = (links: ReadonlyArray<{ id: string; kind: string }>): string =>
  links.map(l => `${l.kind}:${l.id}`).join(', ')
