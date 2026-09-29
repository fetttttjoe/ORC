# plugins/provider-anthropic/src/cache.ts

## Facts
- plugins/provider-anthropic/src/cache.ts injects two ephemeral prompt-cache breakpoints (last system block, last content block of the last message) into every Anthropic request via a custom fetch wrapper, since Anthropic allows up to 4. {obql2l2b @plugins/provider-anthropic/src/cache.ts#markCacheBreakpoints #architecture-current}
