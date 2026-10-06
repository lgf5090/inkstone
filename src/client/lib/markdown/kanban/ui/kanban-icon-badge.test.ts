import { describe, expect, it } from 'vitest'
import { clampIconText } from './kanban-icon-badge'

describe('clampIconText', () => {
  it('keeps a short emoji or word whole', () => {
    expect(clampIconText('🚀')).toBe('🚀')
    expect(clampIconText('Go')).toBe('Go')
  })

  it('cuts a long freeform value by grapheme clusters, not code units', () => {
    const flag = '🏳️‍🌈'
    const long = `a${flag}${flag}${flag}${flag}b`
    expect(clampIconText(long)).toBe(`a${flag}${flag}`)
  })

  it('keeps a multi-code-point emoji cluster whole and cuts plain long text at three clusters', () => {
    expect(clampIconText('👨‍👩‍👧')).toBe('👨‍👩‍👧')
    expect(clampIconText('abcdefgh')).toBe('abc')
  })
})
