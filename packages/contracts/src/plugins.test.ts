import { describe, expect, it } from 'bun:test'
import {
  HOOK_NAME, MCP_SERVER_ID_RE, McpServerConfig, SkillManifest,
  mcpToolName, parseToolRef,
} from './plugins'

describe('SkillManifest', () => {
  const ok = { name: 'my-skill', description: 'does things when asked' }

  it('accepts a minimal valid manifest', () => {
    expect(SkillManifest.parse(ok)).toEqual(ok)
  })

  it('accepts all optional open-spec fields', () => {
    const full = {
      ...ok,
      license: 'Apache-2.0',
      compatibility: 'requires git',
      allowedTools: 'Bash(git:*) Read',
      metadata: { author: 'y', version: '1.0' },
    }
    expect(SkillManifest.parse(full)).toEqual(full)
  })

  it.each([
    ['uppercase', 'My-Skill'],
    ['leading hyphen', '-skill'],
    ['trailing hyphen', 'skill-'],
    ['double hyphen', 'my--skill'],
    ['underscore', 'my_skill'],
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
  ])('rejects bad name: %s', (_label, name) => {
    expect(() => SkillManifest.parse({ ...ok, name })).toThrow()
  })

  it('rejects empty and oversized descriptions', () => {
    expect(() => SkillManifest.parse({ ...ok, description: '' })).toThrow()
    expect(() => SkillManifest.parse({ ...ok, description: 'x'.repeat(1025) })).toThrow()
  })

  it('rejects oversized compatibility', () => {
    expect(() => SkillManifest.parse({ ...ok, compatibility: 'x'.repeat(501) })).toThrow()
  })

  it('rejects unknown top-level fields (strict open spec)', () => {
    expect(() => SkillManifest.parse({ ...ok, model: 'gpt' })).toThrow()
  })
})

describe('tool refs', () => {
  it('parses serverId/toolName', () => {
    expect(parseToolRef('files/read_file')).toEqual({ serverId: 'files', toolName: 'read_file' })
  })

  it('keeps slashes after the first in the tool name', () => {
    expect(parseToolRef('gh/repos/list')).toEqual({ serverId: 'gh', toolName: 'repos/list' })
  })

  it.each(['nofslash', '/leading', 'trailing/', 'Bad-Server/x', 'srv_x/tool'])('throws on malformed ref: %s', ref => {
    expect(() => parseToolRef(ref)).toThrow()
  })

  it('mangles model-facing names to a provider-safe charset', () => {
    expect(mcpToolName('files', 'read_file')).toBe('mcp__files__read_file')
    expect(mcpToolName('gh', 'repos/list')).toBe('mcp__gh__repos_list')
  })

  it('server id charset', () => {
    expect(MCP_SERVER_ID_RE.test('files-2')).toBe(true)
    expect(MCP_SERVER_ID_RE.test('Files')).toBe(false)
    expect(MCP_SERVER_ID_RE.test('a_b')).toBe(false)
  })
})

describe('McpServerConfig', () => {
  it('accepts command with optional args/env', () => {
    expect(McpServerConfig.parse({ command: 'bun', args: ['s.ts'], env: { A: 'b' } }).command).toBe('bun')
    expect(McpServerConfig.parse({ command: 'bun' }).args).toBeUndefined()
  })
  it('rejects empty command', () => {
    expect(() => McpServerConfig.parse({ command: '' })).toThrow()
  })
})

describe('hooks', () => {
  it('exposes the const map', () => {
    expect(HOOK_NAME.event_appended).toBe('event_appended')
    expect(HOOK_NAME.session_start).toBe('session_start')
    expect(HOOK_NAME.session_shutdown).toBe('session_shutdown')
  })
})
