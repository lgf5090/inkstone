import { describe, expect, it } from 'vitest'
import type { InknotePage, InknoteTextBox } from '@shared/inknote/types'
import { countsOfPages, findPageText, highlightPageText, isEmptyPage, outlineOfPages, replacePageText } from './note-search'

function textBox(overrides: Partial<InknoteTextBox> = {}): InknoteTextBox {
  return {
    id: 't1',
    x: 0.1,
    y: 0.1,
    w: 0.4,
    h: 0.1,
    text: 'Hello World',
    fontSize: 26,
    color: '#111111',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
    ...overrides,
  }
}

function page(id: string, texts: InknoteTextBox[], overrides: Partial<InknotePage['content']> = {}): InknotePage {
  return {
    id,
    position: 0,
    rev: 1,
    updatedAt: 1,
    content: { format: 'inknote-page', version: 1, strokes: [], texts, images: [], bg: null, ...overrides },
  }
}

describe('findPageText', () => {
  it('finds every case-insensitive occurrence with a page-relative snippet', () => {
    const pages = [page('p1', [textBox({ id: 'a', text: 'hello world, HELLO again' })]), page('p2', [textBox({ id: 'b', text: 'nothing here' })])]
    const matches = findPageText(pages, 'hello')
    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ pageId: 'p1', pageIndex: 0, textId: 'a', start: 0, end: 5 })
    expect(matches[1]).toMatchObject({ start: 13, end: 18 })
  })

  it('treats a regex-looking query as literal text', () => {
    const pages = [page('p1', [textBox({ text: 'a.b axb' })])]
    expect(findPageText(pages, 'a.b')).toHaveLength(1)
    expect(findPageText(pages, '.*')).toHaveLength(0)
  })

  it('answers nothing for a blank query', () => {
    expect(findPageText([page('p1', [textBox()])], '   ')).toEqual([])
  })
})

describe('replacePageText', () => {
  it('replaces every occurrence and keeps an untouched page identical', () => {
    const first = page('p1', [textBox({ id: 'a', text: 'cat cat' })])
    const second = page('p2', [textBox({ id: 'b', text: 'dog' })])
    const result = replacePageText([first, second], 'CAT', 'mouse')
    expect(result.count).toBe(2)
    expect(result.changedPageIds).toEqual(['p1'])
    expect(result.pages[0]!.content.texts[0]!.text).toBe('mouse mouse')
    expect(result.pages[1]).toBe(second)
  })

  it('keeps replacement dollars literal', () => {
    const result = replacePageText([page('p1', [textBox({ text: 'price' })])], 'price', '$& $1')
    expect(result.pages[0]!.content.texts[0]!.text).toBe('$& $1')
  })

  it('changes nothing for a blank query', () => {
    const pages = [page('p1', [textBox()])]
    const result = replacePageText(pages, ' ', 'x')
    expect(result.count).toBe(0)
    expect(result.changedPageIds).toEqual([])
  })
})

describe('highlightPageText', () => {
  it('paints matching boxes only and clears them all with null', () => {
    const pages = [page('p1', [textBox({ id: 'a', text: 'alpha' }), textBox({ id: 'b', text: 'beta' })])]
    const painted = highlightPageText(pages, 'alp', '#fde68a')
    expect(painted.count).toBe(1)
    expect(painted.pages[0]!.content.texts[0]!.hl).toBe('#fde68a')
    expect(painted.pages[0]!.content.texts[1]!.hl).toBeNull()
    const cleared = highlightPageText(painted.pages, '', null)
    expect(cleared.count).toBe(1)
    expect(cleared.pages[0]!.content.texts[0]!.hl).toBeNull()
  })

  it('does not skip alternating matches across boxes', () => {
    const pages = [page('p1', [textBox({ id: 'a', text: 'hit' }), textBox({ id: 'b', text: 'hit' }), textBox({ id: 'c', text: 'hit' })])]
    expect(highlightPageText(pages, 'hit', '#fff').count).toBe(3)
  })
})

describe('outlineOfPages', () => {
  it('keeps 26px and up, ranks 34px as level one and truncates long text', () => {
    const long = '这是一段很长很长的标题文字用来验证截断行为确实生效'.repeat(2)
    const pages = [page('p1', [
      textBox({ id: 'small', text: 'body', fontSize: 18 }),
      textBox({ id: 'two', text: 'Chapter', fontSize: 26 }),
      textBox({ id: 'one', text: long, fontSize: 34 }),
      textBox({ id: 'blank', text: '   ', fontSize: 40 }),
    ])]
    const entries = outlineOfPages(pages)
    expect(entries.map((entry) => entry.textId)).toEqual(['two', 'one'])
    expect(entries.map((entry) => entry.level)).toEqual([2, 1])
    expect(entries[1]!.text.endsWith('…')).toBe(true)
    expect(entries[1]!.text.length).toBe(41)
  })
})

describe('countsOfPages and isEmptyPage', () => {
  it('counts each object class', () => {
    const pages = [
      page('p1', [textBox(), textBox({ id: 't2' })], { strokes: [{ id: 's1', tool: 'ballpen', shape: null, color: '#000', width: 2, style: 'normal', points: [] }] }),
      page('p2', [], { images: [{ id: 'i1', x: 0, y: 0, w: 1, h: 1, assetId: 'a', url: '/u', rot: 0 }] }),
    ]
    expect(countsOfPages(pages)).toEqual({ pages: 2, strokes: 1, texts: 2, images: 1 })
  })

  it('calls a page with a background non-empty', () => {
    expect(isEmptyPage(page('p1', []).content)).toBe(true)
    expect(isEmptyPage(page('p1', [], { bg: { kind: 'image', assetId: 'a', url: '/u', width: 1, height: 1, alpha: 1 } }).content)).toBe(false)
  })
})
