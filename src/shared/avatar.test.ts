import { describe, expect, it } from 'vitest'
import {
  avatarEmojiPreference,
  avatarIconPreference,
  parseAvatarEmojiPreference,
  parseAvatarIconPreference,
} from './avatar'

describe('avatar preferences', () => {
  it('accepts only listed emoji', () => {
    expect(parseAvatarEmojiPreference(avatarEmojiPreference('😀'))).toBe('😀')
    expect(parseAvatarEmojiPreference('emoji:not-an-emoji')).toBeNull()
    expect(parseAvatarEmojiPreference('dicebear:abcdefghijklmnop')).toBeNull()
  })

  it('accepts only listed icon names', () => {
    expect(parseAvatarIconPreference(avatarIconPreference('cat'))).toBe('cat')
    expect(parseAvatarIconPreference('lucide:not-an-icon')).toBeNull()
    expect(parseAvatarIconPreference('emoji:😀')).toBeNull()
  })
})
