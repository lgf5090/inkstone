// @vitest-environment jsdom
/**
 * The chat's own replies are the surface that hands bodies to the hold.
 *
 * `MarkdownBody` will defer for a transcript that asks it to, and the arithmetic in
 * `markdown-body-offscreen.test.ts` is about that flag. What this file pins is the wiring, which is the
 * half that can silently rot: a reply row that stops passing `deferOffscreen` is a thread where twenty
 * off-screen turns are prism and katex again before the reader scrolls one pixel. Counted at the door the
 * reader actually opens — `MarkdownReply`, the body every stored answer is drawn through.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { AssistantBubble, MarkdownReply } from './MessageParts'
import { useAssistant } from './assistant-store'

const passes = vi.hoisted(() => ({ enhance: 0 }))

vi.mock('../../lib/markdown/enhance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/enhance')>()
  return {
    ...actual,
    enhancePreview: async () => { passes.enhance += 1 },
    renderPendingMermaid: () => undefined,
    renderPendingCharts: () => undefined,
    destroyChartInstances: () => undefined,
  }
})

/** An observer that reports nothing until the case says the body arrived. */
class FakeObserver {
  static instances: FakeObserver[] = []
  readonly observed: Element[] = []

  constructor(private readonly callback: (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void) {
    FakeObserver.instances.push(this)
  }

  observe(target: Element): void { this.observed.push(target) }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return [] }

  report(intersecting: boolean): void {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting: intersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }
}

let root: Root | null = null
let host: HTMLElement | null = null
const originalAssistant = useAssistant.getState()

const TURNS = 20

function mount(node: ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
  return host
}

/** A page of stored answers: the newest one on the reader's screen, the rest below it. */
function Transcript(): ReactNode {
  return createElement(
    'div',
    null,
    Array.from({ length: TURNS }, (_unused, index) => createElement(
      'div',
      // The wrapper carries where the turn sits; the rectangle stub below reads it. Everything but the
      // newest answer is two screens away.
      { key: `turn-${index}`, ...(index === 0 ? {} : { 'data-out-of-view': '1' }) },
      createElement(MarkdownReply, { source: ['An answer:', '', '```ts', `const answer = ${index}`, '```'].join('\n') }),
    )),
  )
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  passes.enhance = 0
  FakeObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const wrapperTop = this.closest?.('[data-out-of-view]') ? 5_000 : 0
    const top = this.classList?.contains('out-of-view') ? 5_000 : wrapperTop
    return {
      top, bottom: top + 200, left: 0, right: 300, x: 0, y: top, width: 300, height: 200,
      toJSON: () => ({}),
    } as DOMRect
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a page of answers the reader has not scrolled to', () => {
  it('draws the one in view and holds the nineteen under it', () => {
    const container = mount(createElement(Transcript))
    expect(passes.enhance, 'a page of held replies drew every one of them').toBe(1)
    // Held, not missing: every reply's words are in the tree the find panel marks and the outline
    // measures, which is the promise the hold is allowed to keep.
    const bodies = [...container.querySelectorAll<HTMLElement>('.ink-prose')]
    expect(bodies, 'a held reply lost its element').toHaveLength(TURNS)
    expect(bodies.filter((node) => node.textContent?.includes('const answer =')).length, 'a held reply lost its text')
      .toBe(TURNS)
  })

  it('draws the rest as the reader reaches them', async () => {
    mount(createElement(Transcript))
    expect(passes.enhance).toBe(1)
    await act(async () => { for (const observer of FakeObserver.instances) observer.report(true) })
    expect(passes.enhance, 'a reply the reader scrolled to was never drawn').toBe(TURNS)
  })

  /**
   * The row, not the body: three of the four contracts read the transcript through what the row carries.
   * `ChatView`'s `focusMessageId` looks a turn up with `querySelectorAll('[data-chat-anchor]')`, the
   * outline measures those same rows, and the scroll correction after "load earlier" works from nodes
   * that must still be the nodes it measured. Holding a reply's drawing may not touch any of that.
   */
  it('leaves the anchor and the words of a held row exactly where they were', async () => {
    useAssistant.setState({ ...originalAssistant, activeId: 'c1' })
    const container = mount(createElement('div', {
      // The scroller the outline and the anchor lookup are both handed.
      'data-scroller': '1',
    }, ...Array.from({ length: 3 }, (_unused, index) => createElement(
      'div',
      { key: `row-${index}`, ...(index === 0 ? {} : { 'data-out-of-view': '1' }) },
      createElement(AssistantBubble, {
        text: `Answer ${index}`,
        reasoning: '',
        tools: [],
        error: null,
        streaming: false,
        messageId: `m-${index}`,
      }),
    ))))

    const anchors = () => [...container.querySelectorAll<HTMLElement>('[data-chat-anchor]')]
    expect(anchors().map((row) => row.dataset.chatAnchor), 'a held row lost the anchor a search jump looks up')
      .toEqual(['m-0', 'm-1', 'm-2'])
    expect(passes.enhance, 'a row two screens away was drawn at mount').toBe(1)
    const bodies = anchors().map((row) => row.querySelector('.ink-prose'))
    expect(bodies.every((node) => node?.isConnected), 'a held row lost its body element').toBe(true)
    expect(bodies.map((node) => node?.textContent).join(' '), 'a held row lost the words find marks')
      .toContain('Answer 2')

    // The held rows arrive, then scroll away again: the elements must be the same ones, still connected.
    await act(async () => { for (const observer of FakeObserver.instances) observer.report(true) })
    await act(async () => { for (const observer of FakeObserver.instances) observer.report(false) })
    expect(anchors().map((row) => row.dataset.chatAnchor), 'the rows changed under the reader').toEqual(['m-0', 'm-1', 'm-2'])
    expect(anchors().map((row) => row.querySelector('.ink-prose')), 'a row that scrolled away was taken back out')
      .toEqual(bodies)
    expect(passes.enhance, 'a round trip redrew the transcript').toBe(3)
  })
})
