# plugins/provider-anthropic/src/oauth.ts

## Facts
- plugins/provider-anthropic/src/oauth.ts's oauthFetch strips the SDK-generated x-api-key header, sets a Bearer token plus anthropic-beta oauth-2025-04-20, and prepends the Claude Code identity string as the first system block, because Anthropic's OAuth beta rejects requests without it. {mz8kbtw7 @plugins/provider-anthropic/src/oauth.ts#oauthFetch #architecture-current}
