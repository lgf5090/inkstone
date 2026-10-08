import { describe, expect, it } from 'vitest'
import { foldTerm } from './fold'
import { buildTokenizer, stripDataUris } from './tokenizer'

const RESEARCH = String.fromCharCode(0x7814, 0x7a76)
const REPORT = String.fromCharCode(0x62a5, 0x544a)

const fold = (value: string) => foldTerm(value, true)

const BOTH = `${RESEARCH}${REPORT}`

function tokenizer(overrides: Partial<Parameters<typeof buildTokenizer>[0]> = {}) {
  return buildTokenizer({
    splitCamelCase: false,
    cjkBigrams: true,
    pinyinSearch: false,
    ...overrides,
  }, fold)
}

describe('tokenizer', () => {
  it('indexes a hyphenated word whole and in parts', () => {
    const tokens = tokenizer().tokenizeForIndex('e-mail client')
    expect(tokens).toContain('e-mail')
    expect(tokens).toContain('e')
    expect(tokens).toContain('mail')
    expect(tokens).toContain('client')
  })

  it('splits camel case only when the reader asked for it', () => {
    expect(tokenizer().tokenizeForIndex('HttpServer')).toContain('httpserver')
    const split = tokenizer({ splitCamelCase: true }).tokenizeForIndex('HttpServer')
    expect(split).toContain('http')
    expect(split).toContain('server')
  })

  it('folds case and accents in every token', () => {
    const tokens = tokenizer().tokenizeForIndex('Café Naïve')
    expect(tokens).toContain('cafe')
    expect(tokens).toContain('naive')
  })

  it('keeps Han characters searchable as single characters and as pairs', () => {
    const tokens = tokenizer().tokenizeForIndex(BOTH)
    expect(tokens).toContain(RESEARCH.charAt(0))
    expect(tokens).toContain(RESEARCH)
    expect(tokens).toContain(REPORT)
    expect(tokens).toContain(BOTH)
  })

  it('does not invent a pair across a separator', () => {
    const tokens = tokenizer().tokenizeForIndex(`${RESEARCH} ${REPORT}`)
    expect(tokens).not.toContain(`${RESEARCH.charAt(1)}${REPORT.charAt(0)}`)
    expect(tokens).toContain(RESEARCH)
    expect(tokens).toContain(REPORT)
  })

  it('drops base64 payloads so an inline image cannot flood the index', () => {
    const payload = `data:image/png;base64,${'A'.repeat(64)}`
    const tokens = tokenizer().tokenizeForIndex(`before ${payload} after`)
    expect(tokens).toContain('before')
    expect(tokens).toContain('after')
    expect(tokens.some((token) => token.length > 20)).toBe(false)
    expect(stripDataUris(`x ${payload} y`)).not.toContain('base64')
  })


  it('reaches a camel-cased word by each half after folding', () => {
    const groups = tokenizer({ splitCamelCase: true }).tokenizeForSearch('HttpServer')
    expect(groups.queries.some((group) => group.queries.includes('http'))).toBe(true)
    expect(groups.queries.some((group) => group.queries.includes('server'))).toBe(true)
  })

  it('builds OR-of-AND groups so one reading matching is enough', () => {
    const groups = tokenizer().tokenizeForSearch('e-mail client')
    expect(groups.combineWith).toBe('OR')
    expect(groups.queries.length).toBeGreaterThan(1)
    expect(groups.queries.every((group) => group.combineWith === 'AND')).toBe(true)
    expect(groups.queries.some((group) => group.queries.includes('e-mail'))).toBe(true)
    expect(groups.queries.some((group) => group.queries.includes('mail'))).toBe(true)
  })

  it('never returns an empty group list for a non-empty query', () => {
    expect(tokenizer().tokenizeForSearch('caf').queries.length).toBeGreaterThan(0)
  })

  it('returns no groups for an empty query', () => {
    expect(tokenizer().tokenizeForSearch('   ').queries).toEqual([])
  })
})

