# Svelte conventions for this package

Runes mode only; legacy features are defects. Enforced by review.

- `$state` ONLY where reactivity is consumed; plain `let` otherwise. Collections that are only
  REASSIGNED (never mutated) use `$state.raw` — API responses, row buffers.
- Compute with `$derived`/`$derived.by`, never `$effect`-assignments. Effects are a last resort
  (external sync); prefer `{@attach ...}` for library integration (sigma), event handlers for
  interaction, `createSubscriber` for external observation.
- Props via `$props()`, treated as changing (derive, don't snapshot). Snippets + `{@render}`,
  never slots. `onclick={...}`, never `on:click`. Keyed `{#each}` always; never index keys.
- Class-with-`$state`-fields for shared reactive state (our stores), not svelte/store.
- clsx-style arrays/objects in `class` attributes, not `class:` directives.
- One responsibility per component; atoms in `lib/components/ui`, molecules in `lib/components`,
  panes in `lib/features`. No string literal spelled twice — tables/consts.

## Typechecking

`.svelte` files are NOT covered by `tsc` — run `bun run check` (svelte-check) in this package.
It needs TypeScript 6 and 7 installed side by side (`typescript@~6` plus the `@typescript/native`
alias) and the `--tsgo` flag; without them it refuses to start, which is how a null-cost crash
reached the browser once.

Errors inside `src/lib/components/ui/**` are the vendored shadcn components hitting TS7's union
complexity limit on DOM prop types. They are upstream's, not ours — judge a change by whether it
adds errors OUTSIDE that directory.

## Validation

Nothing crosses a boundary unparsed. A view's params and result are declared once on
`@orc/ui-core/wire` (`WIRE`, keyed by `ViewName`); `src/lib/api/schemas.ts` re-exports those same
schemas and declares its own for the handful of routes outside the view registry (`/api/session`,
`/api/projects`, `/api/graph`, `/api/health`, action results, localStorage reads), so every
component and `e2e/contract.pw.ts` import from this one file.

Reads go through the view client. `lib/api/view-client.ts`'s `fetchView`/`fetchViewGuarded` (or
`view-query.ts`'s `viewQuery` for a reactive pane) parse a view's response against `WIRE[name].result`
inside the `seq` envelope every view answers in; `client.ts`'s `get`/`post` do the same for the
plain routes above. Nothing else in this app builds a `/api/view/*` URL, parses a view's response,
or keys its TanStack cache entry by hand. **A new read is a new view** — one file under
`packages/ui-core/src/views/`, one entry on `WIRE` — never a new route, a client-side filter, or a
browser fold of the log.

This is not ceremony: a `get<T>()` cast is erased at build time, and four separate shape
mismatches shipped because of it — an empty model picker that made the primary flow impossible,
artifacts rendered as "unrecognised shape", a model's whole cost lens blank, and a note's claims
missing entirely. Every one was invisible until someone looked at the screen.

`e2e/contract.pw.ts` parses real server responses with these same schemas, so drift fails CI.
When it fails, find out WHICH SIDE MOVED — never loosen the schema to make it pass.

## Vendored components

`src/lib/components/ui/**` is upstream shadcn-svelte source. Keep it pristine so
`shadcn-svelte update` never conflicts. Customise in the order the skill prescribes:

1. a built-in `variant` / `size`
2. Tailwind classes via `class` (tailwind-merge lets the caller win over the base classes)
3. a new variant added to the component's `tailwind-variants` block
4. a wrapper component of our own — `Chip`, `Payload`, `ConfirmDialog` are these

Theme changes belong in `app.css`: our palette is mapped onto shadcn's semantic variables
(`--color-primary`, `--color-border`, …), so a token edit restyles every vendored component at
once and none of them need touching.
