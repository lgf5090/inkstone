import { describe, expect, it } from 'vitest'
import { parseFenceInfo, parseLineSpec } from './fence-info'
import { codeTheme, parseCollapseValue, readCodeOptions, writeCodeOptions } from './code-options'
import {
  EXAMPLE_SPLIT_DEFAULTS,
  exampleRatioLabel,
  exampleSplitTracks,
  formatExampleSplitInfo,
  isVerticalExampleLayout,
  parseExampleRatio,
  parseExampleSplit,
} from './example-split'

describe('parseFenceInfo', () => {
  it('reads the language, title and gutter from every spelling the toolbar writes', () => {
    expect(parseFenceInfo('ts').language).toBe('ts')
    expect(parseFenceInfo('{.typescript .line-numbers}').language).toBe('typescript')
    expect(parseFenceInfo('{.ts}').lineNumbers).toBe(false)
    expect(parseFenceInfo('ts line-numbers').lineNumbers).toBe(true)
    expect(parseFenceInfo('ts linenos=1').lineNumbers).toBe(true)
    expect(parseFenceInfo('ts .number-lines').lineNumbers).toBe(true)
    expect(parseFenceInfo('ts line-numbers line-numbers=false').lineNumbers).toBe(false)
    expect(parseFenceInfo('ts line-numbers=0').lineNumbers).toBe(false)
    expect(parseFenceInfo('ts title="src/a.ts"').title).toBe('src/a.ts')
    expect(parseFenceInfo('ts [src/a.ts]').title).toBe('src/a.ts')
    expect(parseFenceInfo('ts start=5').startLine).toBe(5)
    expect(parseFenceInfo('ts start=0').startLine).toBe(1)
  })

  it('collects highlight lines from the brace spec and the named forms', () => {
    expect(parseFenceInfo('ts {2,4-6}').highlightedLines).toEqual([2, 4, 5, 6])
    expect(parseFenceInfo('ts hl_lines="1 3"').highlightedLines).toEqual([1, 3])
    expect(parseFenceInfo('ts {1} hl_lines="7"').highlightedLines).toEqual([1, 7])
    expect(parseFenceInfo('{.ts hl_lines="9"}').highlightedLines).toEqual([9])
    expect(parseFenceInfo('{.ts hl_lines="9"}').language).toBe('ts')
  })

  it('bounds a spec so one typo cannot build a million highlighted lines', () => {
    expect(parseLineSpec('1-5000').length).toBe(1001)
    expect(parseLineSpec('1,1,1,1').length).toBe(1)
    expect(parseLineSpec('a,1,,b,2').length).toBe(2)
    expect(parseLineSpec(Array.from({ length: 400 }, (_, i) => String(i + 1)).join(',')).length).toBe(200)
  })
})

describe('readCodeOptions', () => {
  it('reads the three options the renderer did not carry before', () => {
    expect(readCodeOptions('ts').wrap).toBe(false)
    expect(readCodeOptions('ts wrap').wrap).toBe(true)
    expect(readCodeOptions('ts wrap nowrap').wrap).toBe(false)
    expect(readCodeOptions('ts collapse=12').collapse).toBe(12)
    expect(readCodeOptions('ts collapse=0').collapse).toBe(0)
    expect(readCodeOptions('ts collapse').collapse).toBeNull()
    expect(readCodeOptions('ts theme=dark').theme).toBe('dark')
    expect(readCodeOptions('ts theme="light"').theme).toBe('light')
    expect(readCodeOptions('ts theme=pink').theme).toBe('auto')
  })

  it('keeps the gutter, title and highlight reads the renderer already made', () => {
    const read = readCodeOptions('ts title="a" line-numbers start=3 {2}')
    expect(read).toMatchObject({ title: 'a', lineNumbers: true, startLine: 3, highlighted: [2] })
  })
})

describe('value guards', () => {
  it('accepts only the three palette names and only whole line counts', () => {
    expect(codeTheme('AUTO')).toBe('auto')
    expect(codeTheme('')).toBeNull()
    expect(codeTheme('auto; color: red')).toBeNull()
    expect(parseCollapseValue(' 40 ')).toBe(40)
    expect(parseCollapseValue('1234567')).toBeNull()
    expect(parseCollapseValue('-1')).toBeNull()
    expect(parseCollapseValue('1e3')).toBeNull()
  })
})

describe('writeCodeOptions', () => {
  it('drops a value that equals the default and keeps everything unmanaged', () => {
    const base = readCodeOptions('ts')
    expect(writeCodeOptions('ts', base)).toBe('ts')
    expect(writeCodeOptions('ts title="x"', { ...base, title: 'x' })).toBe('ts title="x"')
    expect(writeCodeOptions('ts wrap', base)).toBe('ts')
    expect(writeCodeOptions('ts', { ...base, wrap: true })).toBe('ts wrap')
    expect(writeCodeOptions('ts layout=rl ratio="3:7"', { ...base, theme: 'dark' }))
      .toBe('ts layout=rl ratio="3:7" theme=dark')
  })

  it('writes the off spelling only when the fence was on, so a plain block stays plain', () => {
    const on = { ...readCodeOptions('ts line-numbers'), lineNumbers: false }
    expect(writeCodeOptions('ts line-numbers', on)).toBe('ts line-numbers=false')
    expect(writeCodeOptions('ts', on)).toBe('ts')
    expect(writeCodeOptions('{.ts .line-numbers}', on)).toBe('{.ts .line-numbers} line-numbers=false')
  })

  it('normalizes a title so it cannot break its own quoting', () => {
    expect(writeCodeOptions('ts', { ...readCodeOptions('ts'), title: 'a"b' })).toBe('ts title="a\'b"')
  })

  it('round-trips: reading what was written gives the same options back', () => {
    const info = 'ts title="utils.ts" line-numbers start=2 {3,5} wrap collapse=20 theme=light'
    const start = readCodeOptions(info)
    for (const next of [
      start,
      { ...start, lineNumbers: false },
      { ...start, title: '' },
      { ...start, highlighted: [] },
      { ...start, wrap: false },
      { ...start, collapse: null },
      { ...start, theme: 'auto' as const },
    ]) {
      const written = writeCodeOptions(info, next)
      expect(readCodeOptions(written), written).toEqual(next)
      expect(readCodeOptions(writeCodeOptions(written, next)), written).toEqual(next)
    }
  })

  it('drops the off flag once the fence no longer claims to be on', () => {
    const off = { ...readCodeOptions('ts line-numbers'), lineNumbers: false }
    expect(readCodeOptions(writeCodeOptions('ts line-numbers', off))).toEqual(off)
    expect(writeCodeOptions(writeCodeOptions('ts line-numbers', off), off)).toBe('ts')
  })
})

describe('example split options', () => {
  it('resolves the info string against the family default', () => {
    expect(parseExampleSplit('md-example', EXAMPLE_SPLIT_DEFAULTS.md)).toEqual({ layout: 'lr', ratio: [45, 55] })
    expect(parseExampleSplit('javascript-example', EXAMPLE_SPLIT_DEFAULTS.js)).toEqual({ layout: 'tb', ratio: [45, 55] })
    expect(parseExampleSplit('md-example layout=vertical ratio="3:7"', EXAMPLE_SPLIT_DEFAULTS.md)).toEqual({ layout: 'tb', ratio: [3, 7] })
    expect(parseExampleSplit('md-example direction=bt', EXAMPLE_SPLIT_DEFAULTS.md)).toEqual({ layout: 'bt', ratio: [45, 55] })
    expect(parseExampleSplit('md-example layout=sideways', EXAMPLE_SPLIT_DEFAULTS.md).layout).toBe('lr')
  })

  it('refuses a ratio that would collapse a panel or overflow the attribute', () => {
    expect(parseExampleRatio('0:5')).toBeNull()
    expect(parseExampleRatio('100:1')).toBeNull()
    expect(parseExampleRatio('3 : 7')).toEqual([3, 7])
    expect(parseExampleRatio('3:7:1')).toBeNull()
    expect(parseExampleRatio('')).toBeNull()
    expect(exampleRatioLabel([45, 55])).toBe('45:55')
    expect(exampleSplitTracks([3, 7])).toBe('3fr 7fr')
    expect(isVerticalExampleLayout('bt')).toBe(true)
    expect(isVerticalExampleLayout('lr')).toBe(false)
  })

  it('writes back a fence that is byte-identical to a plain one after a reset', () => {
    const defaults = EXAMPLE_SPLIT_DEFAULTS.md
    const edited = formatExampleSplitInfo('md-example title="Demo"', { layout: 'rl', ratio: [3, 7] }, defaults)
    expect(edited).toBe('md-example title="Demo" layout=rl ratio="3:7"')
    expect(formatExampleSplitInfo(edited, defaults, defaults)).toBe('md-example title="Demo"')
    expect(formatExampleSplitInfo('md-example layout=rl', defaults, defaults)).toBe('md-example')
  })

  it('round-trips through the info string it produces', () => {
    for (const layout of ['lr', 'rl', 'tb', 'bt'] as const) {
      for (const ratio of [[2, 8], [45, 55], [99, 1]] as const) {
        const next = { layout, ratio: [...ratio] as [number, number] }
        const written = formatExampleSplitInfo('md-example title="x"', next, EXAMPLE_SPLIT_DEFAULTS.md)
        expect(parseExampleSplit(written, EXAMPLE_SPLIT_DEFAULTS.md), written).toEqual(next)
      }
    }
  })
})
