// Test fixture: a real MCP stdio server. Run with `bun fixture-server.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '0.0.0' })

server.registerTool(
  'echo',
  { description: 'echo text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
)
server.registerTool(
  'fail',
  { description: 'always fails', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
)
server.registerTool(
  'grow',
  { description: 'registers a tool named late (fires list_changed)', inputSchema: {} },
  async () => {
    server.registerTool('late', { description: 'late tool', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'late ran' }],
    }))
    return { content: [{ type: 'text', text: 'registered' }] }
  },
)
if (process.env.FIXTURE_CRASH === '1') {
  console.error('fixture: crashing on purpose')
  process.exit(1)
}
await server.connect(new StdioServerTransport())
