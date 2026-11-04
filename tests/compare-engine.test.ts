import { describe, expect, it } from 'vitest'
import { computeTextDiff, formatUnifiedPatch, regexProblem, splitLines } from '../src/shared/tools/compare/engine'
import { DEFAULT_TEXT_OPTIONS, type TextCompareOptions } from '../src/shared/tools/compare/types'

const options = (patch: Partial<TextCompareOptions> = {}): TextCompareOptions => ({ ...DEFAULT_TEXT_OPTIONS, ...patch })

describe('splitLines', () => {
  it('keeps the carriage return when line endings are being compared', () => {
    expect(splitLines('a\r\nb', true)).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb', false)).toEqual(['a\r', 'b'])
  })

  it('keeps a trailing empty line, the way an editor numbers it', () => {
    expect(splitLines('a\n', true)).toEqual(['a', ''])
  })
})

describe('computeTextDiff', () => {
  it('pairs a removed and an added line into one change', () => {
    const result = computeTextDiff('a\nb\nc', 'a\nB\nc', options())
    expect(result.stats).toEqual({ added: 0, removed: 0, changed: 1, changedBlocks: 1, same: 2 })
    expect(result.hunks).toHaveLength(1)
    expect(result.rows.find((row) => row.kind === 'changed')).toMatchObject({ leftNo: 2, rightNo: 2 })
  })

  it('reports an insertion without a change row', () => {
    const result = computeTextDiff('a\nc', 'a\nb\nc', options())
    expect(result.stats.added).toBe(1)
    expect(result.stats.changed).toBe(0)
    expect(result.rows.filter((row) => row.kind === 'added')).toHaveLength(1)
  })

  it('ignores case when asked', () => {
    const result = computeTextDiff('Alpha\nBeta', 'alpha\nbeta', options({ ignoreCase: true }))
    expect(result.hunks).toHaveLength(0)
    expect(result.stats.same).toBe(2)
    const strict = computeTextDiff('Alpha\nBeta', 'alpha\nbeta', options())
    expect(strict.stats.changed).toBe(2)
  })

  it('collapses whitespace when asked', () => {
    const result = computeTextDiff('a   b\tc', 'a b c', options({ ignoreWhitespace: true }))
    expect(result.hunks).toHaveLength(0)
    const strict = computeTextDiff('a   b\tc', 'a b c', options())
    expect(strict.stats.changed).toBe(1)
  })

  it('removes the ignore pattern before comparing', () => {
    const result = computeTextDiff('value #1\nend', 'value #2\nend', options({ ignoreRegex: '#\\d' }))
    expect(result.hunks).toHaveLength(0)
  })

  it('rejects an invalid ignore pattern instead of silently ignoring it', () => {
    expect(() => computeTextDiff('a', 'b', options({ ignoreRegex: '(' }))).toThrow(/expression/i)
    expect(regexProblem('(')).not.toBeNull()
    expect(regexProblem('#\\d')).toBeNull()
  })

  it('treats CRLF and LF as the same when ignoring line endings', () => {
    expect(computeTextDiff('a\r\nb', 'a\nb', options()).hunks).toHaveLength(0)
  })

  it('reports the line whose carriage return is now compared as changed', () => {
    const result = computeTextDiff('a\r\nb', 'a\nb', options({ ignoreLineEndings: false }))
    expect(result.stats.changed).toBe(1)
    expect(result.stats.same).toBe(1)
  })

  it('leaves changes outside the selected range out of the answer', () => {
    const left = 'one\ntwo\nthree\nfour\nfive'
    const right = 'one\nTWO\nthree\nfour\nfive'
    expect(computeTextDiff(left, right, options()).hunks).toHaveLength(1)
    const ranged = computeTextDiff(left, right, options({ leftRange: { from: 4, to: 5 }, rightRange: { from: 4, to: 5 } }))
    expect(ranged.hunks).toHaveLength(0)
    expect(ranged.stats.changed).toBe(0)
    expect(ranged.rows).toHaveLength(5)
  })

  it('reports the change character offsets against the original documents', () => {
    const result = computeTextDiff('x\ny', 'x\nY', options())
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ fromA: 2, toA: 3, fromB: 2, toB: 3 })
  })

  it('offsets an insertion at the end of the document', () => {
    const result = computeTextDiff('a', 'a\nb', options())
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ fromA: 1, toA: 1, fromB: 2, toB: 3 })
  })

  it('folds unchanged runs that are further apart than the context', () => {
    const left = ['a', ...Array.from({ length: 20 }, (_, index) => `same ${index}`), 'x'].join('\n')
    const right = ['A', ...Array.from({ length: 20 }, (_, index) => `same ${index}`), 'x'].join('\n')
    const result = computeTextDiff(left, right, options())
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]!.rows.some((row) => row.kind === 'same')).toBe(true)
  })
})

describe('formatUnifiedPatch', () => {
  it('formats the rows the reader was shown', () => {
    const result = computeTextDiff('a\nb\nc', 'a\nB\nc', options())
    const patch = formatUnifiedPatch(result, 'left.txt', 'right.txt')
    expect(patch).toBe([
      '--- left.txt',
      '+++ right.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n'))
  })

  it('answers empty when nothing changed', () => {
    expect(formatUnifiedPatch(computeTextDiff('a', 'a', options()), 'l', 'r')).toBe('')
  })
})
