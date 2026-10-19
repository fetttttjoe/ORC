import { describe, expect, it } from 'bun:test'
import { ProjectIdentity } from './project-identity'

describe('ProjectIdentity', () => {
  it('parses a full identity', () => {
    expect(ProjectIdentity.parse({ name: 'p', dir: '/x' })).toEqual({ name: 'p', dir: '/x' })
  })
  it('refuses an empty name', () => {
    expect(ProjectIdentity.safeParse({ name: '', dir: '/x' }).success).toBe(false)
  })
  it('refuses an empty dir', () => {
    expect(ProjectIdentity.safeParse({ name: 'p', dir: '' }).success).toBe(false)
  })
})
