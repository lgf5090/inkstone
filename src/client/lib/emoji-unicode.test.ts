import { beforeAll, describe, expect, it } from 'vitest'
import { preloadPinyin } from './pinyin'
import {
  EMOJI_TONE_SLOTS,
  emojiCharForCode,
  emojiEntryForChar,
  emojiToneHand,
  emojiUnicodeEntries,
  emojiUnicodeGroups,
  emojiUnicodeIsLoaded,
  emojiWithTone,
  loadEmojiUnicode,
  searchEmojiUnicode,
} from './emoji-unicode'

const HAND = String.fromCodePoint(0x270b)
const SKIN = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map((point) => String.fromCodePoint(point))
const GRINNING = '😀'
const HEART = '❤️'
const THUMBS_UP = '👍'
const TONE_LIGHT = String.fromCodePoint(0x1f44d, 0x1f3fb)
const LAUGHING = '😆'
const STAR_STRUCK = '🤩'
/** kai-xin, the Han keyword the set carries for the grinning face. */
const KAI_XIN = String.fromCodePoint(0x5f00, 0x5fc3)
/** ai-xin, for the red heart. */
const AI_XIN = String.fromCodePoint(0x7231, 0x5fc3)

beforeAll(async () => {
  await loadEmojiUnicode()
  await preloadPinyin()
})

describe('the emoji set', () => {
  it('arrives whole, and only once it has been asked for', () => {
    expect(emojiUnicodeIsLoaded()).toBe(true)
    const groups = emojiUnicodeGroups()
    expect(groups.map((group) => group.id)).toEqual([
      'people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags',
    ])
    expect(emojiUnicodeEntries()).toHaveLength(1870)
    expect(groups.reduce((total, group) => total + group.entries.length, 0)).toBe(1870)
  })

  it('is a second call for the same promise, not a second download', async () => {
    expect(await loadEmojiUnicode()).toBeUndefined()
    expect(emojiUnicodeEntries()).toHaveLength(1870)
  })

  it('gives every entry a glyph, a lowercase code and no colon in its words', () => {
    for (const entry of emojiUnicodeEntries()) {
      expect(entry.code).toBeTruthy()
      expect(entry.code).toBe(entry.code.toLowerCase())
      expect(entry.code).not.toContain(':')
      expect(entry.char.length).toBeGreaterThan(0)
      expect(entry.name).toBeTruthy()
      expect(entry.keywords ?? '').not.toContain(':')
    }
  })

  it('lists each code once and each glyph once, so a row cannot key-collide', () => {
    const codes = emojiUnicodeEntries().map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
    const chars = emojiUnicodeEntries().map((entry) => entry.char)
    expect(new Set(chars).size).toBe(chars.length)
  })
})

describe('shortcodes', () => {
  it('resolves a code, the underscore spelling of a dashed one, and an alias', () => {
    expect(emojiCharForCode('grin')).toBe('😁')
    expect(emojiCharForCode('star-struck')).toBe(STAR_STRUCK)
    expect(emojiCharForCode('star_struck')).toBe(STAR_STRUCK)
    expect(emojiCharForCode('grinning_face_with_star_eyes')).toBe(STAR_STRUCK)
    expect(emojiCharForCode('satisfied')).toBe(LAUGHING)
  })

  it('answers in lower case whatever the author typed', () => {
    expect(emojiCharForCode('HEART')).toBe(HEART)
  })

  it('has no answer for a word that is not one', () => {
    expect(emojiCharForCode('definitely_not_an_emoji_code')).toBeUndefined()
    expect(emojiCharForCode('')).toBeUndefined()
  })

  it('finds the entry a drawn glyph came from, tone included', () => {
    expect(emojiEntryForChar(GRINNING)?.code).toBe('grinning')
    expect(emojiEntryForChar(TONE_LIGHT)?.code).toBe('+1')
    expect(emojiEntryForChar('not a glyph')).toBeUndefined()
  })
})

describe('skin tones', () => {
  it('offers six slots and names each one with a hand', () => {
    expect(EMOJI_TONE_SLOTS).toEqual([0, 1, 2, 3, 4, 5])
    expect(emojiToneHand(0)).toBe(HAND)
    expect(emojiToneHand(1)).toBe(HAND + SKIN[0])
    expect(emojiToneHand(5)).toBe(HAND + SKIN[4])
    expect(emojiToneHand(99)).toBe(HAND + SKIN[4])
  })

  it('applies a tone only where the set drew one', () => {
    const thumb = emojiEntryForChar(THUMBS_UP)!
    expect(emojiWithTone(thumb, 0)).toBe(THUMBS_UP)
    expect(emojiWithTone(thumb, 1)).toBe(TONE_LIGHT)
    expect(emojiWithTone(thumb, 5)).toBe(THUMBS_UP + SKIN[4])
    const grin = emojiEntryForChar(GRINNING)!
    expect(grin.tones).toBeUndefined()
    expect(emojiWithTone(grin, 3)).toBe(GRINNING)
  })

  it('refuses a slot the entry does not have instead of inventing one', () => {
    const thumb = emojiEntryForChar(THUMBS_UP)!
    expect(emojiWithTone(thumb, -1)).toBe(THUMBS_UP)
    expect(emojiWithTone(thumb, 99)).toBe(THUMBS_UP)
  })
})

describe('emoji search', () => {
  const codes = (query: string) => searchEmojiUnicode(query).map((hit) => hit.entry.code)

  it('says nothing before the set is there and nothing to an empty query', () => {
    expect(searchEmojiUnicode('')).toEqual([])
    expect(searchEmojiUnicode('   ')).toEqual([])
  })

  it('puts the exact code first', () => {
    expect(codes('heart')[0]).toBe('heart')
    expect(codes('rocket')[0]).toBe('rocket')
  })

  it('finds a name the reader only half remembers', () => {
    expect(codes('grinning face')).toContain('grinning')
    expect(codes('thumbs')).toContain('+1')
  })

  it('reads a phrase as every word at once, not as one long word', () => {
    expect(codes('red heart')[0]).toBe('heart')
    expect(codes('happy face')).toContain('grinning')
    // One word fits the face, the other only fits the rocket, so the phrase is nobody's answer.
    expect(codes('grinning rocket')).toEqual([])
  })

  it('answers in the language the reader types', () => {
    expect(codes(KAI_XIN)).toContain('grinning')
    expect(codes(AI_XIN)).toContain('heart')
  })

  it('answers to the initials of a Chinese word, the way the rest of the app does', () => {
    expect(codes('kx')).toContain('grinning')
    expect(codes('aixin')).toContain('heart')
  })

  it('finds an emoji pasted into the box', () => {
    expect(codes(GRINNING)[0]).toBe('grinning')
  })

  it('caps the list and keeps the cap honest', () => {
    const hits = searchEmojiUnicode('a', 5)
    expect(hits.length).toBeLessThanOrEqual(5)
  })

  it('gives up on letters no emoji is named with', () => {
    expect(searchEmojiUnicode('qqqqzzzz')).toEqual([])
  })
})
