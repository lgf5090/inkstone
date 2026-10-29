import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES, DEFAULT_INKNOTE_SETTINGS, PAPER_STYLES } from './constants'
import { normalizeInknoteColor, normalizePaperColor, paperSurfaceFor } from './color'
import { sanitizeInknoteSettings } from './settings'

describe('inknote shared model', () => {
  it('keeps seven built-in templates and ten paper styles', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(7)
    expect(PAPER_STYLES.map((entry) => entry.id)).toEqual([
      'blank', 'line', 'grid', 'dot', 'cornell', 'check', 'planner', 'story', 'music', 'legal',
    ])
    expect(BUILTIN_TEMPLATES.every((entry) => entry.builtIn && entry.paper)).toBe(true)
  })

  it('normalizes only hex colours and named paper colours', () => {
    expect(normalizeInknoteColor('#abc')).toBe('#aabbcc')
    expect(normalizeInknoteColor('#AABBCC')).toBe('#aabbcc')
    expect(normalizeInknoteColor('rgb(1,2,3)')).toBeNull()
    expect(normalizeInknoteColor('javascript:alert(1)')).toBeNull()
    expect(normalizePaperColor('cream')).toBe('cream')
    expect(normalizePaperColor('#000')).toBe('#000000')
  })

  it('derives a dark surface for a dark custom paper', () => {
    expect(paperSurfaceFor('black').dark).toBe(true)
    expect(paperSurfaceFor('#000000').dark).toBe(true)
    expect(paperSurfaceFor('#fffefb').dark).toBe(false)
  })
})

describe('sanitizeInknoteSettings', () => {
  it('returns defaults for junk and clamps ranges', () => {
    const clean = sanitizeInknoteSettings({
      tool: 'lasso',
      color: 'not-a-colour',
      penWidth: 999,
      eraserSize: 1,
      ttsRate: 9,
      textSize: 'large',
      defaultPaper: { style: 'nope', color: '#123456', spacing: 'wide' },
      openTabs: ['a'.repeat(26), 'a'.repeat(26), 'bad'],
      favorites: [{ tool: 'pen', color: '#fff', width: 5, style: 'normal', eraserSize: 24 }],
      aiPrompt: 'x'.repeat(5000),
    })
    expect(clean.tool).toBe('lasso')
    expect(clean.color).toBe(DEFAULT_INKNOTE_SETTINGS.color)
    expect(clean.penWidth).toBe(30)
    expect(clean.eraserSize).toBe(8)
    expect(clean.ttsRate).toBe(2)
    expect(clean.textSize).toBe(DEFAULT_INKNOTE_SETTINGS.textSize)
    expect(clean.defaultPaper).toEqual({ style: 'line', color: '#123456', spacing: 'wide' })
    expect(clean.openTabs).toEqual(['a'.repeat(26)])
    expect(clean.favorites).toHaveLength(1)
    expect(clean.aiPrompt).toHaveLength(2000)
  })

  it('does not mutate its input and ignores prototype keys', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"tool":"pen"}') as unknown
    const clean = sanitizeInknoteSettings(input)
    expect(clean.tool).toBe('pen')
    expect((clean as unknown as { polluted?: boolean }).polluted).toBeUndefined()
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('keeps every documented default field', () => {
    expect(sanitizeInknoteSettings(null)).toEqual(DEFAULT_INKNOTE_SETTINGS)
  })
})
