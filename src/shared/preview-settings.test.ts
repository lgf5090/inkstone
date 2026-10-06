import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'

describe('link hover preview settings', () => {
  it('ships the ported defaults', () => {
    expect(DEFAULT_SETTINGS.preview.linkHover).toBe(true)
    expect(DEFAULT_SETTINGS.preview.linkHoverDelayMs).toBe(320)
    expect(DEFAULT_SETTINGS.preview.linkPreviewLength).toBe(4000)
    expect(DEFAULT_SETTINGS.preview.pinnedWindowSize).toBe('medium')
    expect(DEFAULT_SETTINGS.preview.pinnedWindowWidth).toBe(460)
    expect(DEFAULT_SETTINGS.preview.pinnedWindowHeight).toBe(520)
  })

  it('keeps a stored profile without the new keys on the defaults', () => {
    const merged = mergeSettings({ preview: { math: false } })
    expect(merged.preview.math).toBe(false)
    expect(merged.preview.linkHover).toBe(true)
    expect(merged.preview.linkHoverDelayMs).toBe(320)
    expect(merged.preview.pinnedWindowSize).toBe('medium')
  })

  it('clamps numeric settings to the range the sliders offer', () => {
    const merged = mergeSettings({
      preview: {
        linkHoverDelayMs: 999_999,
        linkPreviewLength: -50,
        pinnedWindowWidth: Number.MAX_SAFE_INTEGER,
        pinnedWindowHeight: 0.2,
      },
    })
    expect(merged.preview.linkHoverDelayMs).toBe(1000)
    expect(merged.preview.linkPreviewLength).toBe(300)
    expect(merged.preview.pinnedWindowWidth).toBe(1200)
    expect(merged.preview.pinnedWindowHeight).toBe(140)
  })

  it('rejects values that are not the type the key declares', () => {
    const merged = mergeSettings({
      preview: {
        linkHover: 'yes',
        linkHoverDelayMs: '320',
        pinnedWindowSize: 'huge',
        pinnedWindowWidth: Number.NaN,
      },
    })
    expect(merged.preview.linkHover).toBe(true)
    expect(merged.preview.linkHoverDelayMs).toBe(320)
    expect(merged.preview.pinnedWindowSize).toBe('medium')
    expect(merged.preview.pinnedWindowWidth).toBe(460)
  })

  it('applies a patch without disturbing the other preview keys', () => {
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, { preview: { linkHoverDelayMs: 500 } })
    expect(patched.preview.linkHoverDelayMs).toBe(500)
    expect(patched.preview.linkPreviewLength).toBe(4000)
    expect(patched.preview.math).toBe(true)
  })
})
