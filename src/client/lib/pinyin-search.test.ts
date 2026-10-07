import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { fuzzyFilter, fuzzyMatch, matchesQuery, splitByRanges } from './fuzzy'
import { pinyinKeysOf, preloadPinyin } from './pinyin'
import { renderElement } from './test-render'

/**
 * The labels a Chinese interface actually uses, written as escapes so the locale gate still owns
 * every piece of copy in the repository. Each one carries its reading in the gloss.
 */
const SELECT_ALL = '\u5168\u9009' // quan-xuan
const PRESENT_MODE = '\u6f14\u793a\u6a21\u5f0f' // yan-shi-mo-shi
const TAG_TAB_PAGE = '\u6807\u7b7e Tab \u9875' // biao-qian, tab, ye
const EXPORT_PDF = 'PDF \u5bfc\u51fa' // dao-chu
const INSERT = '\u63d2\u5165' // cha-ru
const TABLE = '\u8868\u683c' // biao-ge
const CODE_BLOCK = '\u4ee3\u7801\u5757' // dai-ma-kuai
const QUICK_ENTRY = '\u5feb\u6377\u5165\u53e3' // kuai-jie-ru-kou
const SCATTERED = 'q \u5b57 z \u65e0 \u5173 \u7cfb x' // q-zi-z-wu-guan-xi-x
const BODY_TEXT = '\u6b63\u6587\u5185\u5bb9' // zheng-wen-nei-rong
const LATIN_TEXT = 'body text, nothing else'

beforeAll(async () => {
  await preloadPinyin()
})

describe('pinyin keys', () => {
  it('derives first letters and full readings for a Chinese label', () => {
    expect(pinyinKeysOf(SELECT_ALL)).toEqual({ initials: 'qx', full: 'quanxuan' })
    expect(pinyinKeysOf(PRESENT_MODE)).toEqual({ initials: 'ysms', full: 'yanshimoshi' })
  })

  it('keeps the latin letters a label already carries', () => {
    expect(pinyinKeysOf(TAG_TAB_PAGE)?.initials).toBe('bqtaby')
    expect(pinyinKeysOf(EXPORT_PDF)?.initials).toBe('pdfdc')
  })

  it('refuses text holding no Chinese, since there is no reading to add', () => {
    expect(pinyinKeysOf('Alpha Beta')).toBeNull()
    expect(pinyinKeysOf('')).toBeNull()
  })

  it('hands the same object back for the same label, so a listing does not re-derive it per keystroke', () => {
    const first = pinyinKeysOf(PRESENT_MODE)
    expect(pinyinKeysOf(PRESENT_MODE)).toBe(first)
    expect(pinyinKeysOf(SELECT_ALL)).not.toBe(first)
  })

  it('refuses a note body, whose initials are nobody’s query', () => {
    const body = `${SELECT_ALL} ${'x'.repeat(400)}`
    expect(body.length).toBeGreaterThan(200)
    expect(pinyinKeysOf(body)).toBeNull()
  })
})

describe('fuzzyMatch with the dictionary', () => {
  it('finds a Chinese label from its first letters', () => {
    const match = fuzzyMatch(SELECT_ALL, 'qx')
    expect(match).not.toBeNull()
    expect(match!.score).toBeGreaterThan(500)
  })

  it('finds it from the full reading too', () => {
    expect(fuzzyMatch(SELECT_ALL, 'quanxuan')).not.toBeNull()
    expect(fuzzyMatch(SELECT_ALL, 'quan')).not.toBeNull()
  })

  it('reports a reading hit without ranges, because the typed letters are not in the label', () => {
    expect(fuzzyMatch(SELECT_ALL, 'qx')!.ranges).toEqual([])
    expect(splitByRanges(SELECT_ALL, fuzzyMatch(SELECT_ALL, 'qx')!.ranges)).toEqual([{ text: SELECT_ALL, hit: false }])
  })

  it('reads a spaced query the way the letter crawl does', () => {
    expect(fuzzyMatch(SELECT_ALL, 'q x')).not.toBeNull()
    expect(fuzzyMatch(SELECT_ALL, 'qx')).not.toBeNull()
  })

  it('never reads punctuation or a reversed query as pinyin', () => {
    expect(fuzzyMatch(SELECT_ALL, 'q-x')).toBeNull()
    expect(fuzzyMatch(SELECT_ALL, 'xq')).toBeNull()
    expect(fuzzyMatch(INSERT, 'qx')).toBeNull()
    expect(fuzzyMatch(SELECT_ALL, '\u5168')).not.toBeNull()
  })

  it('keeps a literal substring ahead of a reading', () => {
    const ranked = fuzzyFilter([SELECT_ALL, `qx ${QUICK_ENTRY}`], 'qx', (text) => text)
    expect(ranked.map((entry) => entry.item)).toEqual([`qx ${QUICK_ENTRY}`, SELECT_ALL])
    expect(ranked[0]!.match.ranges).toEqual([[0, 2]])
  })

  it('puts a reading ahead of an accidental letter crawl', () => {
    const ranked = fuzzyFilter([SELECT_ALL, SCATTERED], 'qx', (text) => text)
    expect(ranked[0]!.item).toBe(SELECT_ALL)
    expect(fuzzyMatch(SCATTERED, 'qx')!.score).toBeLessThan(fuzzyMatch(SELECT_ALL, 'qx')!.score)
  })

  it('does not invent matches for latin-only listings', () => {
    expect(fuzzyMatch('Export note', 'qp')).toBeNull()
    expect(fuzzyMatch('Export note', 'epn')).not.toBeNull()
  })

  it('ranks a long label below a short one on the same reading', () => {
    const long = SELECT_ALL + QUICK_ENTRY + CODE_BLOCK + PRESENT_MODE
    expect(long.length).toBeGreaterThanOrEqual(13)
    expect(fuzzyMatch(SELECT_ALL, 'qx')!.score).toBeGreaterThan(fuzzyMatch(long, 'qx')!.score)
  })

  it('reads the title line of a note body too long to have initials of its own', () => {
    const body = `${SELECT_ALL}\n${BODY_TEXT.repeat(60)}`
    expect(body.length).toBeGreaterThan(200)
    expect(fuzzyMatch(body, 'qx')).not.toBeNull()
    expect(matchesQuery(body, 'quanxuan')).toBe(true)
    expect(matchesQuery(body, 'zz')).toBe(false)
    expect(matchesQuery(`Welcome ${LATIN_TEXT.repeat(60)}`, 'qx')).toBe(false)
  })
})

describe('matchesQuery', () => {
  it('is true for an empty query on anything', () => {
    expect(matchesQuery(SELECT_ALL, '   ')).toBe(true)
    expect(matchesQuery('', 'qx')).toBe(false)
  })

  it('accepts any of the three readings of a listing', () => {
    expect(matchesQuery(SELECT_ALL, '\u5168')).toBe(true)
    expect(matchesQuery(SELECT_ALL, 'qx')).toBe(true)
    expect(matchesQuery(SELECT_ALL, 'quanxuan')).toBe(true)
    expect(matchesQuery(SELECT_ALL, 'q x')).toBe(true)
    expect(matchesQuery('Insert board', 'ib')).toBe(true)
  })

  it('still says no to an unrelated query', () => {
    expect(matchesQuery(SELECT_ALL, 'zz')).toBe(false)
    expect(matchesQuery(INSERT, 'qx')).toBe(false)
  })

  it('ignores the case of the letters typed', () => {
    expect(matchesQuery(EXPORT_PDF, 'dc')).toBe(true)
    expect(matchesQuery(EXPORT_PDF, 'DC')).toBe(true)
  })
})

describe('the module-level matchers agree with each other', () => {
  it('reports a reading for every label the menu search shows', () => {
    for (const label of [SELECT_ALL, PRESENT_MODE, INSERT, TABLE, CODE_BLOCK]) {
      const keys = pinyinKeysOf(label)
      expect(keys, label).not.toBeNull()
      expect(fuzzyMatch(label, keys!.initials), label).not.toBeNull()
      expect(matchesQuery(label, keys!.full), label).toBe(true)
    }
  })
})

describe('a search that runs before the dictionary lands', () => {
  it('loses only the reading, not the literal or the crawl', async () => {
    vi.resetModules()
    const pinyin = await import('./pinyin')
    const fuzzy = await import('./fuzzy')
    expect(pinyin.pinyinIsLoaded()).toBe(false)
    expect(pinyin.pinyinKeysOf(SELECT_ALL)).toBeNull()
    expect(fuzzy.matchesQuery(SELECT_ALL, 'qx')).toBe(false)
    expect(fuzzy.matchesQuery(SELECT_ALL, '\u5168')).toBe(true)
    expect(fuzzy.matchesQuery('Insert board', 'ib')).toBe(true)

    await pinyin.preloadPinyin()
    expect(pinyin.pinyinIsLoaded()).toBe(true)
    expect(fuzzy.matchesQuery(SELECT_ALL, 'qx')).toBe(true)
  })

  it('re-renders a subscribed listing when the dictionary arrives', async () => {
    vi.resetModules()
    const pinyin = await import('./pinyin')
    const seen: number[] = []

    function Listing(): ReactNode {
      seen.push(pinyin.usePinyinVersion())
      return null
    }

    const view = renderElement(createElement(Listing))
    expect(seen[0]).toBe(0)

    await act(async () => { await pinyin.preloadPinyin() })
    expect(seen[seen.length - 1]).toBeGreaterThan(0)

    view.unmount()
  })
})
