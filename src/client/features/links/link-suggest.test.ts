import { beforeAll, describe, expect, it } from 'vitest'
import { preloadPinyin } from '../../lib/pinyin'
import { matchTier, subpathQuery, suggestTargets, type SuggestInput } from './link-suggest'

const OPTIONS = { syncAlias: true, aliasMode: 'heading' as const, aliasSeparator: ' > ' }

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    notes: [
      { id: '1', title: 'Deep Notes', updatedAt: 30 },
      { id: '2', title: 'Notes', updatedAt: 20 },
      { id: '3', title: '\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0', updatedAt: 10 },
    ],
    headings: [{ level: 2, text: 'Setup' }, { level: 1, text: 'Overview' }],
    headingOwnerTitle: '',
    currentTitle: 'Current',
    ...over,
  }
}

function titles(query: string, over: Partial<SuggestInput> = {}): string[] {
  return suggestTargets(query, input(over), OPTIONS).map((row) => row.label)
}

beforeAll(async () => {
  await preloadPinyin()
})

describe('matchTier', () => {
  it('ranks an exact name above a prefix, a prefix above a substring', () => {
    expect(matchTier('Notes', 'notes')).toBe(0)
    expect(matchTier('Notes', 'not')).toBe(1)
    expect(matchTier('Deep Notes', 'not')).toBe(2)
  })

  it('reads the initials of a Chinese title', () => {
    expect(matchTier('\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0', 'sdyjbj')).toBe(3)
    expect(matchTier('\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0', 'zzz')).toBeNull()
  })

  it('falls back to a letter-by-letter crawl', () => {
    expect(matchTier('Deep Notes', 'dns')).toBe(4)
  })

  it('treats an empty query as a browse, not a miss', () => {
    expect(matchTier('Anything', '')).toBe(2)
  })
})

describe('suggestTargets', () => {
  it('offers every note when nothing has been typed yet, most recent first', () => {
    expect(titles('')).toEqual(['Deep Notes', 'Notes', '\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0'])
  })

  it('puts a note named exactly what was typed ahead of one that merely contains it', () => {
    expect(titles('notes')[0]).toBe('Notes')
  })

  it('finds a Chinese note by its initials', () => {
    expect(titles('sdyjbj')).toContain('\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0')
  })

  it('stops at the limit', () => {
    const many = { notes: Array.from({ length: 40 }, (_, index) => ({ id: `${index}`, title: `Note ${index}`, updatedAt: index })) }
    expect(suggestTargets('note', input(many), { ...OPTIONS, limit: 6 })).toHaveLength(6)
  })

  it('offers the current note headings once the reader types the separator', () => {
    const rows = suggestTargets('#', input(), OPTIONS)
    expect(rows.map((row) => row.target)).toEqual(['#Setup', '#Overview'])
    expect(rows.every((row) => row.kind === 'heading')).toBe(true)
  })

  it('filters the headings after the separator', () => {
    expect(titles('#ver', { headingOwnerTitle: 'Deep Notes' })).toEqual(['Overview'])
  })

  it('names a heading of another note with that note in the target', () => {
    const row = suggestTargets('Deep#Setup', input({ headingOwnerTitle: 'Deep Notes' }), OPTIONS)[0]
    expect(row?.target).toBe('Deep Notes#Setup')
    expect(row?.detail).toBe('Deep Notes')
  })

  it('writes the alias the settings ask for', () => {
    const query = 'Deep#Setup'
    const over = { headingOwnerTitle: 'Deep Notes' }
    expect(suggestTargets(query, input(over), OPTIONS)[0]?.text).toBe('Setup')
    expect(suggestTargets(query, input(over), { ...OPTIONS, aliasMode: 'note-then-heading' })[0]?.text).toBe('Deep Notes > Setup')
    expect(suggestTargets(query, input(over), { ...OPTIONS, aliasMode: 'heading-then-note' })[0]?.text).toBe('Setup > Deep Notes')
    expect(suggestTargets(query, input(over), { ...OPTIONS, syncAlias: false })[0]?.text).toBe('')
  })

  it('mixes the current note headings into a plain query', () => {
    const rows = suggestTargets('se', input({ currentTitle: 'Current' }), OPTIONS)
    expect(rows.map((row) => row.kind)).toContain('heading')
  })

  it('leaves the display text alone for a note when alias sync is off', () => {
    const row = suggestTargets('notes', input(), { ...OPTIONS, syncAlias: false })[0]
    expect(row?.target).toBe('Notes')
    expect(row?.text).toBe('')
  })
})

describe('subpathQuery', () => {
  it('splits at the first separator only', () => {
    expect(subpathQuery('a/B#x#y')).toEqual({ note: 'a/B', fragment: 'x#y' })
    expect(subpathQuery('B')).toBeNull()
  })
})
