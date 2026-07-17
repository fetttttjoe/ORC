// Wraps the AI SDK's mock language model ('ai/test') into a pop-the-next-response script.
//
// API-DRIFT from the brief's guess (verified against node_modules/.bun/ai@7.0.30.../ai/dist/test/index.d.ts
// and node_modules/.bun/@ai-sdk+provider@4.0.3/.../dist/index.d.ts):
//   - Class name `MockLanguageModelV4` was correct as guessed.
//   - `finishReason` is NOT a bare string in LanguageModelV4GenerateResult. It's an object:
//       type LanguageModelV4FinishReason = { unified: 'stop' | ... | 'tool-calls' | ...; raw: string | undefined }
//   - `usage` is NOT the flat `{ inputTokens: number, outputTokens: number }` from the brief (that shape
//     is v2-era and also what generateText's *high-level* result.usage looks like). At the low-level
//     provider/mock doGenerate boundary, LanguageModelV4Usage is nested:
//       { inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }
//   - `content[].type: 'tool-call'` with `input: string` (JSON-stringified) was correct as guessed.
import { MockLanguageModelV4 } from 'ai/test'

export interface ScriptedTurn {
  text?: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
}

export function scriptModel(turns: ScriptedTurn[]) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[i++] ?? { text: '' }
      const isToolCall = (turn.toolCalls?.length ?? 0) > 0
      return {
        finishReason: { unified: isToolCall ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        content: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...(turn.toolCalls ?? []).map(c => ({
            type: 'tool-call' as const, toolCallId: c.toolCallId, toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
        ],
        warnings: [],
      }
    },
  })
}
