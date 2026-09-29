# plugins/provider-openai/src/auth.ts

## Facts
- plugins/provider-openai/src/auth.ts's credentialHeaders reads Codex ChatGPT credentials from ~/.codex/auth.json (or CODEX_HOME) and throws if the JWT access_token's exp claim has already passed. {iut3ix78 @plugins/provider-openai/src/auth.ts#credentialHeaders #architecture-current}
