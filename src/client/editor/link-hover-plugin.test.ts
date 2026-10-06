import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { markdownDecorations } from './decorations'
import { linkHoverExtension, linkHoverFacet } from './link-hover-plugin'
import { encodeDataValue } from '../lib/markdown/data-attr'

const CHAR_W = 4
const LINE_H = 16
let activeContentDom: HTMLElement | null = null

beforeAll(() => {
  installLayoutPolyfills()
})
afterAll(() => {
  restoreLayoutPolyfills()
})

function contentRoot(): HTMLElement | null {
  return activeContentDom ?? document.querySelector('.cm-content')
}

function globalCharOffset(node: Node, offset: number): number {
  const root = contentRoot()
  if (!root || !root.contains(node)) return Math.max(0, offset)
  let before = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    if (current === node) break
    before += current.data.length
  }
  return before + Math.min(Math.max(0, offset), (node.textContent ?? '').length)
}

function elementStartOffset(element: Element): number {
  const root = contentRoot()
  if (!root || !root.contains(element)) return 0
  let before = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    if (element.contains(current)) break
    before += current.data.length
  }
  return before
}

function installLayoutPolyfills(): void {
  Range.prototype.getClientRects = function () {
    const left = 4 + globalCharOffset(this.startContainer, this.startOffset) * CHAR_W
    return [{
      left, top: 4, right: left + 2, bottom: 4 + LINE_H, width: 2, height: LINE_H,
    }] as unknown as DOMRectList
  }
  Element.prototype.getBoundingClientRect = function () {
    const left = 4 + elementStartOffset(this) * CHAR_W
    const width = Math.max(2, (this.textContent ?? '').length * CHAR_W)
    return {
      left, top: 4, right: left + width, bottom: 4 + LINE_H, width, height: LINE_H,
      x: left, y: 4, toJSON: () => ({}),
    } as DOMRect
  }
}

function restoreLayoutPolyfills(): void {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
    x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
}

function mountEditor(doc = 'Before [[Note B]] after') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const proposals: Array<HTMLElement | null> = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, addKeymap: false }),
        markdownDecorations,
        linkHoverExtension(),
        linkHoverFacet.of({
          propose: (link) => {
            proposals.push(link)
          },
          hide: () => true,
        }),
      ],
    }),
    parent: container,
  })
  activeContentDom = view.contentDOM
  return { view, proposals, container }
}

async function waitForMeasure(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

describe('caret proposal from link hover plugin', () => {
  it('proposes the wiki link when the caret sits inside a mark', async () => {
    const { view, proposals, container } = mountEditor()
    const start = view.state.doc.toString().indexOf('[[Note B]]')
    view.dispatch({ selection: { anchor: start + 2 } })
    await waitForMeasure()
    expect(proposals.at(-1)).not.toBeNull()
    expect(proposals.at(-1)!.textContent).toBe('[[Note B]]')
    expect(proposals.at(-1)!.dataset.wikilink).toBe(encodeDataValue('Note B'))

    view.dispatch({ selection: { anchor: 0 } })
    await waitForMeasure()
    expect(proposals.at(-1)).toBeNull()

    view.destroy()
    container.remove()
  })

  it('keeps the caret proposal stable when the mouse leaves the mark', async () => {
    const { view, proposals, container } = mountEditor()
    const start = view.state.doc.toString().indexOf('[[Note B]]')
    view.dispatch({ selection: { anchor: start + 2 } })
    await waitForMeasure()
    const mark = container.querySelector<HTMLElement>('.cm-md-wikilink')!
    const proposalsBefore = proposals.length

    const line = container.querySelector<HTMLElement>('.cm-line')!
    line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }))
    await waitForMeasure()
    expect(proposals.length).toBe(proposalsBefore)
    expect(proposals.at(-1)).toBe(mark)

    view.contentDOM.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    await waitForMeasure()
    expect(proposals.length).toBe(proposalsBefore)
    expect(proposals.at(-1)).toBe(mark)

    view.destroy()
    container.remove()
  })
})

describe('hashtag proposals from the editor', () => {
  it('proposes the tag under the pointer', async () => {
    const { view, proposals, container } = mountEditor('Status #work/deep done')
    const mark = container.querySelector<HTMLElement>('.cm-md-tag')!
    mark.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 8 }))
    await waitForMeasure()
    expect(proposals.at(-1), 'the hashtag mark itself').toBe(mark)
    expect(mark.dataset.tag).toBe(encodeDataValue('work/deep'))
    view.destroy()
    container.remove()
  })

  it('proposes the tag the caret sits inside', async () => {
    const { view, proposals, container } = mountEditor('Status #work/deep done')
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('work') + 2 } })
    await waitForMeasure()
    expect(proposals.at(-1)!.dataset.tag).toBe(encodeDataValue('work/deep'))
    view.destroy()
    container.remove()
  })
})

describe('mouse hover behavior of link hover plugin', () => {
  it('does not re-propose when the mouse hovers the same mark the caret is in', async () => {
    const { view, proposals, container } = mountEditor()
    const start = view.state.doc.toString().indexOf('[[Note B]]')
    view.dispatch({ selection: { anchor: start + 2 } })
    await waitForMeasure()
    const proposalsBefore = proposals.length

    const mark = container.querySelector<HTMLElement>('.cm-md-wikilink')!
    mark.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }))
    await waitForMeasure()
    expect(proposals.length).toBe(proposalsBefore)

    view.destroy()
    container.remove()
  })

  it('switches to the mouse-hovered mark and falls back to the caret mark', async () => {
    const { view, proposals, container } = mountEditor(
      'Caret [[Note B]] and [[Note C]] here',
    )
    const start = view.state.doc.toString().indexOf('[[Note B]]')
    view.dispatch({ selection: { anchor: start + 2 } })
    await waitForMeasure()
    expect(proposals.at(-1)!.textContent).toBe('[[Note B]]')

    const marks = [...container.querySelectorAll<HTMLElement>('.cm-md-wikilink')]
    const markC = marks.find((mark) => mark.textContent === '[[Note C]]')!
    markC.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }))
    await waitForMeasure()
    expect(proposals.at(-1)!.textContent).toBe('[[Note C]]')

    const line = container.querySelector<HTMLElement>('.cm-line')!
    line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }))
    await waitForMeasure()
    expect(proposals.at(-1)!.textContent).toBe('[[Note B]]')

    view.destroy()
    container.remove()
  })

  it('proposes a rendered wiki link from live preview', async () => {
    const { view, proposals, container } = mountEditor('Some [[Note B]] text')
    const line = container.querySelector<HTMLElement>('.cm-line')!
    const rendered = document.createElement('a')
    rendered.className = 'wikilink'
    rendered.dataset.wikilink = encodeDataValue('Note B|shown as C')
    rendered.textContent = 'shown as C'
    line.appendChild(rendered)

    rendered.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }))
    await waitForMeasure()
    expect(proposals.at(-1)).toBe(rendered)
    expect(rendered.dataset.wikilink).toBe(encodeDataValue('Note B|shown as C'))

    view.destroy()
    container.remove()
  })

  it('lets escape through to the editor when nothing is proposed', async () => {
    const { view, proposals, container } = mountEditor('No link here')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitForMeasure()
    expect(proposals).toHaveLength(0)

    view.destroy()
    container.remove()
  })
})
