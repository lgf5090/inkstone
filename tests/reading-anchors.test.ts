import { beforeEach, describe, expect, it } from 'vitest'
import { buildTextIndex, offsetForPoint, pointForOffset, sliceText, elementForOffset } from '../src/client/features/reading/engine/text-index'
import { anchorFrom, paintHighlights, resolveAnchor } from '../src/client/features/reading/engine/highlight-anchor'
import type { Highlight } from '../src/client/features/reading/engine/../types'

const host = document.createElement('div')

function chapter(markup: string): HTMLElement {
  host.innerHTML = markup
  return host
}

function highlight(over: Partial<Highlight> = {}): Highlight {
  return {
    id: 'hl-1', bookId: 'b', chapter: 0, start: 0, end: 0, color: 'yellow',
    quote: '', prefix: '', suffix: '', comment: '', createdAt: 0, updatedAt: 0, ...over,
  }
}

beforeEach(() => {
  host.innerHTML = ''
})

describe('buildTextIndex', () => {
  it('numbers every text node against one concatenated string', () => {
    const root = chapter('<p>第一段</p><p>第二段</p>')
    const index = buildTextIndex(root)
    expect(index.text).toBe('第一段第二段')
    expect(index.nodes).toHaveLength(2)
    expect(index.starts).toEqual([0, 3])
  })

  it('ignores a node that holds nothing', () => {
    const index = buildTextIndex(chapter('<p>a</p><span></span><p>b</p>'))
    expect(index.text).toBe('ab')
    expect(index.nodes).toHaveLength(2)
  })

  it('keeps whitespace, because an offset has to mean the same thing twice', () => {
    const index = buildTextIndex(chapter('<p>  hello   world  </p>'))
    expect(index.text).toBe('  hello   world  ')
  })

  it('round-trips a point through an offset', () => {
    const root = chapter('<p>abc</p><p>defg</p>')
    const index = buildTextIndex(root)
    const point = pointForOffset(index, 5)
    expect(point?.node.nodeValue).toBe('defg')
    expect(point?.offset).toBe(2)
    expect(offsetForPoint(index, point!.node, point!.offset)).toBe(5)
  })

  it('maps the very end of the chapter into the last node', () => {
    const index = buildTextIndex(chapter('<p>abc</p><p>defg</p>'))
    const point = pointForOffset(index, index.text.length)
    expect(point?.node.nodeValue).toBe('defg')
    expect(point?.offset).toBe(4)
  })

  it('answers -1 for a point it does not hold', () => {
    const index = buildTextIndex(chapter('<p>abc</p>'))
    expect(offsetForPoint(index, document.createElement('i'), 0)).toBe(-1)
  })

  it('finds the nearest identified element for a jump target', () => {
    const root = chapter('<p>one</p><h2 id="scene">two</h2><p>three</p>')
    const index = buildTextIndex(root)
    expect(elementForOffset(index, 1)?.tagName).toBe('P')
    expect(elementForOffset(index, 4)?.id).toBe('scene')
  })
})

describe('resolveAnchor', () => {
  it('trusts the offsets when the words still agree', () => {
    const index = buildTextIndex(chapter('<p>道可道，非常道。名可名，非常名。</p>'))
    const made = anchorFrom(index, 4, 8)
    expect(made.quote).toBe('非常道。')
    expect(resolveAnchor(index, highlight({ start: 4, end: 8, ...made }))).toEqual({ start: 4, end: 8, state: 'exact' })
  })

  it('moves to the words when the edition shifted under it', () => {
    const original = buildTextIndex(chapter('<p>前言。这里是一句被划线的话。</p>'))
    const made = anchorFrom(original, 5, 14)
    const reissued = buildTextIndex(chapter('<p>新版前言更长一些。这里是一句被划线的话。</p>'))
    const resolved = resolveAnchor(reissued, highlight({ start: 5, end: 14, ...made }))
    expect(resolved.state).toBe('drifted')
    expect(sliceText(reissued, resolved.start, resolved.end)).toBe(made.quote)
  })

  it('prefers the candidate whose neighbours match', () => {
    const index = buildTextIndex(chapter('<p>重复句。中间。重复句。结尾</p>'))
    const second = index.text.indexOf('重复句', 1)
    const made = anchorFrom(index, second, second + 3)
    // The offsets are nonsense (the edition moved), so only the context can say which of the two
    // identical sentences this highlight was made on.
    const resolved = resolveAnchor(index, highlight({ start: 99, end: 102, ...made }))
    expect(resolved.start).toBe(second)
    expect(resolved.state).toBe('drifted')
  })

  it('calls a highlight it cannot find an orphan instead of moving it', () => {
    const index = buildTextIndex(chapter('<p>完全不同的正文。</p>'))
    const resolved = resolveAnchor(index, highlight({ start: 0, end: 4, quote: '消失的句子', prefix: '', suffix: '' }))
    expect(resolved.state).toBe('orphan')
  })
})

describe('paintHighlights', () => {
  const paints = { yellow: 'rgba(255,206,64,.45)', green: 'rgba(118,214,108,.42)' }
  const paintOf = (one: Highlight) => paints[one.color as 'yellow'] ?? paints.yellow!

  function paint(root: HTMLElement, list: Highlight[]) {
    const index = buildTextIndex(root)
    const resolved = new Map(list.map((one) => [one.id, resolveAnchor(index, one)]))
    const marks = paintHighlights(index, list, resolved, paintOf)
    return { marks, repainted: buildTextIndex(root) }
  }

  it('wraps a range that sits inside one text node', () => {
    const root = chapter('<p>道可道，非常道。</p>')
    const index = buildTextIndex(root)
    const anchor = anchorFrom(index, 3, 6)
    const { marks, repainted } = paint(root, [highlight({ start: 3, end: 6, ...anchor })])
    expect(root.querySelectorAll('.reader-mark')).toHaveLength(1)
    expect(root.querySelector('.reader-mark')?.textContent).toBe('，非常')
    // Painting must not change what the chapter's text is, or every later offset would be wrong.
    expect(repainted.text).toBe(index.text)
    expect(marks.byHighlight.get('hl-1')).toHaveLength(1)
  })

  it('splits a range that crosses two nodes', () => {
    const root = chapter('<p>第一段文字</p><p>第二段文字</p>')
    const anchor = anchorFrom(buildTextIndex(root), 2, 8)
    const { repainted } = paint(root, [highlight({ start: 2, end: 8, ...anchor })])
    expect(root.querySelectorAll('.reader-mark')).toHaveLength(2)
    expect([...root.querySelectorAll('.reader-mark')].map((one) => one.textContent).join('')).toBe('段文字第二段')
    expect(repainted.text).toBe('第一段文字第二段文字')
  })

  it('stacks overlapping highlights and records both ids', () => {
    const root = chapter('<p>abcdefgh</p>')
    const first = highlight({ id: 'a', start: 0, end: 6, color: 'yellow', ...anchorFrom(buildTextIndex(root), 0, 6) })
    const second = highlight({ id: 'b', start: 3, end: 8, color: 'green', ...anchorFrom(buildTextIndex(root), 3, 8) })
    paint(root, [first, second])
    const marks = [...root.querySelectorAll<HTMLElement>('.reader-mark')]
    expect(marks.map((one) => one.dataset.hl)).toEqual(['a', 'a b', 'b'])
    expect(marks[1]!.style.getPropertyValue('--reader-mark')).toBe(paints.green)
  })

  it('marks a highlighted passage that carries a comment', () => {
    const root = chapter('<p>带批注的一句</p>')
    const anchor = anchorFrom(buildTextIndex(root), 0, 6)
    paint(root, [highlight({ start: 0, end: 6, comment: '  这里要重读  ', ...anchor })])
    expect(root.querySelector('.reader-mark')?.dataset.hasComment).toBe('true')
  })

  it('paints nothing for an orphan and reports it', () => {
    const root = chapter('<p>只有这些字</p>')
    const { marks } = paint(root, [highlight({ start: 0, end: 3, quote: '不在书里' })])
    expect(root.querySelectorAll('.reader-mark')).toHaveLength(0)
    expect(marks.orphaned).toEqual(['hl-1'])
  })
})
