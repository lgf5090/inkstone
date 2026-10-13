// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  footnotePointerOf,
  looksLikeNote,
  noteTargetFromHtml,
  noteTextOf,
} from '../src/client/features/reading/engine/footnotes'

function html(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'text/html')
}

describe('what counts as a footnote reference', () => {
  it.each([
    ['noteref', '', true],
    ['footnote', '', true],
    ['endnote', '', true],
    ['chapter', '', false],
    ['', 'footnote-ref', true],
    ['', 'toc-link', false],
  ])('reads epub:type=%s class=%s as %j', (type, className, expected) => {
    expect(looksLikeNote(type, className)).toBe(expected)
  })

  it('takes a reference out of a superscript even when it says nothing', () => {
    const doc = html('<p>正文<sup><a data-reader-fragment="n3">3</a></sup></p>')
    const anchor = doc.querySelector('a')!
    expect(footnotePointerOf(anchor, null)).toMatchObject({ label: '3', fragment: 'n3', href: '' })
  })

  it('refuses a plain link to another part of the book', () => {
    const doc = html('<p><a data-reader-href="OEBPS/c2.xhtml" data-reader-fragment="c2">第二章</a></p>')
    expect(footnotePointerOf(doc.querySelector('a'), null)).toBeNull()
  })

  it('accepts a link whose target is the note, however the anchor is written', () => {
    const doc = html('<a data-reader-fragment="note-1">1</a><aside id="note-1" epub:type="footnote"><p>注</p></aside>')
    const anchor = doc.querySelector('a')!
    const target = doc.getElementById('note-1')!
    expect(footnotePointerOf(anchor, target)?.fragment).toBe('note-1')
  })

  it('needs a fragment before it will call anything a link', () => {
    const doc = html('<a epub:type="noteref" href="notes.xhtml">注</a>')
    expect(footnotePointerOf(doc.querySelector('a'), null)).toBeNull()
  })
})

describe('the words of a note', () => {
  it('drops the back-link and the publisher’s whitespace', () => {
    const doc = html(`
      <aside id="n1" epub:type="footnote">
        <p>这是一条脚注，
        跨了两行。</p>
        <p><a href="#p1" class="backlink">↩</a></p>
      </aside>`)
    expect(noteTextOf(doc.getElementById('n1')!)).toBe('这是一条脚注， 跨了两行。')
  })

  it('cuts a note that will not fit and says so', () => {
    const doc = html(`<div id="x">${'字'.repeat(40)}</div>`)
    const text = noteTextOf(doc.getElementById('x')!, 20)
    expect(text.length).toBe(20)
    expect(text.endsWith('…')).toBe(true)
  })

  it('finds the element a fragment names, and nothing when it does not', () => {
    const chapter = '<html><body><p id="a1">一</p><aside id="fn2">二</aside></body></html>'
    expect(noteTargetFromHtml(chapter, 'fn2')?.textContent).toBe('二')
    expect(noteTargetFromHtml(chapter, 'missing')).toBeNull()
    expect(noteTargetFromHtml(chapter, '')).toBeNull()
  })
})
