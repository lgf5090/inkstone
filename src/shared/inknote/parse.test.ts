import { describe, expect, it } from 'vitest'
import { emptyPageContent, extractPageText, normalizeLegacyPage, parseInknotePageContent, parseNote2Envelope, sanitizePageForSave, serializePageContent } from './parse'
import type { InknotePageContent } from './types'

const ASSET = `a${'b'.repeat(25)}`

function page(overrides: Partial<InknotePageContent> = {}): InknotePageContent {
  return {
    ...emptyPageContent(),
    strokes: [{
      id: 's1', tool: 'pen', style: 'normal', shape: null, color: '#123456', width: 4,
      points: [{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4, p: 0.6 }],
    }],
    texts: [{
      id: 't1', x: 0.1, y: 0.2, w: 0.3, h: 0.1, text: 'Hello 世界', fontSize: 26,
      color: '#1e293b', align: 'left', bold: false, italic: false, underline: false,
      hl: null, lh: 1.3, list: null,
    }],
    images: [{ id: 'i1', x: 0.2, y: 0.2, w: 0.4, h: 0.3, assetId: ASSET, url: `/api/inknote/assets/${ASSET}`, rot: 0 }],
    ...overrides,
  }
}

describe('parseInknotePageContent', () => {
  it('round-trips a page and extracts its text', () => {
    const raw = serializePageContent(page())
    const parsed = parseInknotePageContent(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.content.strokes[0]!.points).toHaveLength(2)
    expect(extractPageText(parsed.content)).toBe('Hello 世界')
    expect(serializePageContent(parsed.content)).toBe(raw)
  })

  it('rejects wrong envelopes, bad JSON and oversized content', () => {
    expect(parseInknotePageContent('{"format":"other","version":1}')).toEqual({ ok: false, reason: 'invalid_shape' })
    expect(parseInknotePageContent('{')).toEqual({ ok: false, reason: 'invalid_json' })
    const big = page({ texts: [{ ...page().texts[0]!, text: 'x'.repeat(1_900_000) }] })
    expect(parseInknotePageContent(JSON.stringify(big))).toEqual({ ok: false, reason: 'too_large' })
  })

  it('drops malformed items without letting them reach the page', () => {
    const parsed = parseInknotePageContent(JSON.stringify({
      ...page(),
      strokes: [{ id: 'bad', tool: 'pen', color: 'red', points: [] }],
      images: [{ id: 'x', url: 'https://evil.example/x.png' }],
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.content.strokes).toHaveLength(0)
    expect(parsed.content.images).toHaveLength(0)
    expect(parsed.dropped).toBeGreaterThan(0)
  })

  it('collects only the account asset ids a save references', () => {
    const result = sanitizePageForSave(serializePageContent(page()))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.assetIds).toEqual([ASSET])
  })
})

describe('legacy note2 pages', () => {
  it('maps data URL media to pending assets', () => {
    const legacy = normalizeLegacyPage({
      strokes: [{ id: 's', tool: 'pen', color: '#1e293b', width: 4, points: [{ x: 1, y: 1, p: 1 }] }],
      texts: [{ id: 't', x: 0, y: 0, w: 0.2, h: 0.1, text: 'legacy', fontSize: 26, color: '#1e293b', align: 'left' }],
      images: [{ id: 'i', x: 0, y: 0, w: 0.2, h: 0.2, src: 'data:image/png;base64,AAAA' }],
      bg: { src: 'data:image/jpeg;base64,BBBB', alpha: 0.5 },
    })
    expect(legacy).not.toBeNull()
    expect(legacy!.pendingAssets.map((entry) => entry.path)).toEqual(['images.0.src', 'bg.src'])
    expect(legacy!.content.images[0]!.url).toBe('')
    expect(legacy!.content.bg?.alpha).toBe(0.5)
  })

  it('recognises both note2 export envelopes', () => {
    expect(parseNote2Envelope({ format: 'note2', version: 1, type: 'note', note: { id: 'n' } })?.notes).toHaveLength(1)
    expect(parseNote2Envelope({ format: 'note2', version: 1, type: 'library', library: { notes: { a: {}, b: {} } } })?.notes).toHaveLength(2)
    expect(parseNote2Envelope({ format: 'note2', version: 1, type: 'other' })).toBeNull()
  })
})
