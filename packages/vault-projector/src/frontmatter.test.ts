import { describe, expect, it } from 'bun:test'
import { frontmatter } from './frontmatter'

describe('frontmatter', () => {
  it('wraps block-style YAML in --- fences', () => {
    const md = frontmatter({ type: 'plan' })
    expect(md).toStartWith('---\n')
    expect(md).toEndWith('\n---\n')
    expect(md).toContain('type: plan')
    expect(md).toMatch(/^---\n[\s\S]+\n---\n$/)
  })
})
