// @vitest-environment node
/**
 * Carrying quick-add spans onto the line the field holds.
 *
 * The parser measures a collapsed, trimmed line; the field holds what was typed. Every case here is a
 * line where those two strings are not the same length, because that is the only way an offset can land
 * on the wrong word while still painting the right one. The claim under test is narrow and load-bearing:
 * a returned range, sliced out of the raw line and normalized, is exactly the token's own text.
 */
import { expect, it } from 'vitest'
import { normalizeQuickAddInput, parseQuickAdd } from '@shared/todos/quick-parse'
import { quickAddHighlights } from './quick-add-highlight'

const NOW = Date.parse('2026-10-19T17:30:00Z')
const CN = 'Asia/Shanghai'

/** The spans the parser found in `input`, placed on `input` itself. */
function spansOf(input: string): { kind: string, text: string, start: number, end: number }[] {
  const parsed = parseQuickAdd(input, NOW, CN)
  return quickAddHighlights(input, parsed.tokens).map((range) => ({
    ...range,
    text: input.slice(range.start, range.end),
  }))
}

it('leaves the offsets alone when the line was already the one the parser read', () => {
  const parsed = parseQuickAdd('明天下午3点 交周报 #工作', NOW, CN)
  expect(quickAddHighlights(parsed.source, parsed.tokens)).toEqual(
    parsed.tokens.map((token) => ({ kind: token.kind, start: token.start, end: token.end }))
      .sort((a, b) => a.start - b.start),
  )
})

it('answers in the order the words were written, not the order the chips are grouped', () => {
  // The array the parser returns is grouped date, time, then tag; the line opens with the tag.
  const spans = spansOf('#工作 明天三点')
  expect(spans.map((span) => span.kind)).toEqual(['tag', 'date', 'time'])
  expect(spans.map((span) => span.text)).toEqual(['#工作', '明天', '三点'])
})

it('reaches over the spaces a reader left in the line', () => {
  // One token spans the whole clock phrase, so its band has to cover both spaces the reader typed.
  const spans = spansOf('下午  3点')
  expect(spans.map((span) => span.text)).toEqual(['下午  3点'])
  expect(spans[0]!.start).toBe(0)
  expect(spans[0]!.end).toBe(6)
})

it('slides every span by the spaces at the ends of the line', () => {
  const spans = spansOf('   明天   下午3点  交周报  ')
  expect(spans.map((span) => normalizeQuickAddInput(span.text))).toEqual(['明天', '下午3点'])
  expect(spans[0]!.text).toBe('明天')
  expect(spans[0]!.start).toBe(3)
  expect(spans[1]!.text).toBe('下午3点')
  expect(spans[1]!.start).toBe(8)
})

it('keeps a span whole when a tab or a newline stands where a space should be', () => {
  const spans = spansOf('交周报\t#工作\n!2')
  expect(spans.map((span) => normalizeQuickAddInput(span.text))).toEqual(['#工作', '!2'])
})

it('says nothing about a line it recognised nothing in', () => {
  expect(spansOf('给花浇水')).toEqual([])
})

it('drops an offset the line does not hold instead of guessing where it meant', () => {
  // The parser cannot hand one of these over; a caller built by hand can, and a band drawn at a shifted
  // position is the defect this module exists to prevent, so an unknown offset paints nothing.
  const input = '明天 买牛奶'
  expect(quickAddHighlights(input, [
    { kind: 'date', text: '明天', start: 0, end: 2 },
    { kind: 'tag', text: '#nope', start: 12, end: 17 },
  ])).toEqual([{ kind: 'date', start: 0, end: 2 }])
})
