import { describe, expect, it } from 'bun:test'
import { Door, NO_CHAT, Origin } from './origin'

describe('Origin', () => {
  it('requires chatId as a key — an absent key is not a null chat', () => {
    expect(() => Origin.parse({ door: Door.web })).toThrow()
  })
  it('accepts an explicit null chat and keeps the door', () => {
    const parsed = Origin.parse({ chatId: null, door: Door.web })
    expect(parsed.chatId).toBeNull()
    expect(parsed.door).toBe(Door.web)
  })
  it('NO_CHAT names the door it came through', () => {
    expect(NO_CHAT(Door.cli)).toEqual({ chatId: null, door: Door.cli })
  })
})
