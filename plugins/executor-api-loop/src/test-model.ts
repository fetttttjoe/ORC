// Wraps the AI SDK mock language model into a pop-the-next-response script
import { MockLanguageModelV4 } from 'ai/test'

export interface ScriptedTurn {
  text?: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
  throws?: unknown
}

// seenTools receives the advertised tool names per call; only what the mock got proves narrowing
export function scriptModel(turns: ScriptedTurn[], seenTools?: string[][]) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async (options: { tools?: Array<{ name: string }> }) => {
      seenTools?.push((options.tools ?? []).map(t => t.name).sort())
      const turn = turns[i++] ?? { text: '' }
      if (turn.throws !== undefined) throw turn.throws
      const isToolCall = (turn.toolCalls?.length ?? 0) > 0
      return {
        finishReason: { unified: isToolCall ? 'tool-calls' as const : 'stop' as const, raw: undefined },
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
