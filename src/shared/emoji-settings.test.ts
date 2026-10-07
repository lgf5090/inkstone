import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMOJI_SKIN_TONE_MAX, mergeSettings, mergeSettingsPatch } from './constants'

describe('the emoji settings', () => {
  it('ship on, in the character spelling, with no tone applied', () => {
    const settings = mergeSettings({})
    expect(settings.editor.emojiToolbarButton).toBe(true)
    expect(settings.editor.emojiInsertFormat).toBe('native')
    expect(settings.editor.emojiSkinTone).toBe(0)
    expect(settings.preview.emojiShortcodes).toBe(true)
  })

  it('take each value the interface can send', () => {
    const settings = mergeSettings({
      editor: { emojiToolbarButton: false, emojiInsertFormat: 'shortcode', emojiSkinTone: 3 },
      preview: { emojiShortcodes: false },
    })
    expect(settings.editor.emojiToolbarButton).toBe(false)
    expect(settings.editor.emojiInsertFormat).toBe('shortcode')
    expect(settings.editor.emojiSkinTone).toBe(3)
    expect(settings.preview.emojiShortcodes).toBe(false)
  })

  it('refuse a format that is not one of the two', () => {
    expect(mergeSettings({ editor: { emojiInsertFormat: 'twemoji' } }).editor.emojiInsertFormat).toBe('native')
    expect(mergeSettings({ editor: { emojiInsertFormat: null } }).editor.emojiInsertFormat).toBe('native')
  })

  it('clamp a tone to a slot the set has, and ignore a string', () => {
    expect(mergeSettings({ editor: { emojiSkinTone: -4 } }).editor.emojiSkinTone).toBe(0)
    expect(mergeSettings({ editor: { emojiSkinTone: 99 } }).editor.emojiSkinTone).toBe(EMOJI_SKIN_TONE_MAX)
    expect(mergeSettings({ editor: { emojiSkinTone: 2.6 } }).editor.emojiSkinTone).toBe(3)
    expect(mergeSettings({ editor: { emojiSkinTone: '2' } }).editor.emojiSkinTone).toBe(0)
    expect(mergeSettings({ editor: { emojiSkinTone: true } }).editor.emojiSkinTone).toBe(0)
  })

  it('read a non-boolean as no answer rather than as false', () => {
    expect(mergeSettings({ preview: { emojiShortcodes: 'false' } }).preview.emojiShortcodes).toBe(true)
    expect(mergeSettings({ editor: { emojiToolbarButton: 0 } }).editor.emojiToolbarButton).toBe(true)
  })

  it('survive a patch that names only one of them', () => {
    const base = mergeSettings({ editor: { emojiSkinTone: 4, emojiInsertFormat: 'shortcode' } })
    const patched = mergeSettingsPatch(base, { editor: { emojiToolbarButton: false } })
    expect(patched.editor.emojiToolbarButton).toBe(false)
    expect(patched.editor.emojiSkinTone).toBe(4)
    expect(patched.editor.emojiInsertFormat).toBe('shortcode')
    expect(patched.preview.emojiShortcodes).toBe(true)
  })

  it('are part of the shape the account stores, so a patch cannot smuggle a sixth tone', () => {
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, { editor: { emojiSkinTone: 77, emojiInsertFormat: 'x' } })
    expect(patched.editor.emojiSkinTone).toBe(EMOJI_SKIN_TONE_MAX)
    expect(patched.editor.emojiInsertFormat).toBe('native')
  })
})
