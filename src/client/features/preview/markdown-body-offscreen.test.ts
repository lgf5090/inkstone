// @vitest-environment jsdom
/**
 * The one-way hold on a Markdown body that starts off screen.
 *
 * A read-only surface that draws four hundred turns draws four hundred prism runs and four hundred katex
 * passes before the reader has scrolled anywhere, and every one of them is work inside a bubble two
 * screens away. The numbers below are the whole subject: what one mount costs with the hold and what it
 * cost without it, counted rather than "looks snappier".
 *
 * The other half is what the hold is forbidden to touch. Four contracts in this app read the transcript
 * through DOM that is already mounted — find marks rendered text, `focusMessageId` looks an anchor up
 * with `querySelectorAll('[data-chat-anchor]')`, the scroll correction after "load earlier" assumes the
 * nodes above the reader stay put, and the outline measures their rectangles — so a deferred body keeps
 * its markup, its text and its place in the tree, and arriving is the only thing the observer is
 * watching for. Cases here assert that holding is not unmounting, in both directions.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MarkdownBody } from './MarkdownBody'

/** How many times each pass was actually asked for. Counted, because that is the claim being tested. */
const passes = vi.hoisted(() => ({
  enhance: 0,
  render: 0,
}))

const SOURCE = ['A snippet:', '', '```ts', 'const answer = 42', '```', '', '$x^2$'].join('\n')

vi.mock('../../lib/markdown/enhance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/enhance')>()
  return {
    ...actual,
    // The pass prism and katex are run from, counted instead of run: what is under test is how often a
    // surface asks for it, not what it draws.
    enhancePreview: async () => { passes.enhance += 1 },
    renderPendingMermaid: () => undefined,
    renderPendingCharts: () => undefined,
    destroyChartInstances: () => undefined,
  }
})

vi.mock('../../lib/markdown/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/renderer')>()
  return {
    ...actual,
    // Called through: the markup is the one thing a deferred body must still have, so the count is
    // asserted rather than changed.
    renderMarkdown: (source: string) => {
      passes.render += 1
      return actual.renderMarkdown(source)
    },
  }
})

/**
 * An observer the case drives by hand. A browser delivers one record per observed element as soon as it
 * starts watching, which is what makes a synchronous "where am I" question unnecessary; this answers the
 * same way and lets a test say arrival, and say leaving.
 */
class FakeObserver {
  static instances: FakeObserver[] = []
  readonly observed: Element[] = []
  disconnected = false
  rootMargin: string | undefined

  constructor(
    private readonly callback: (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void,
    options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this)
    this.rootMargin = options?.rootMargin
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Reports every element this observer holds as arrived, or as gone. */
  report(intersecting: boolean): void {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting: intersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

function mount(node: ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
  return host
}

/** A transcript of `count` bodies: the newest in the room the reader is in, the rest below it. */
function Transcript({ count, hold }: { count: number, hold: boolean }): ReactNode {
  return createElement(
    'div',
    null,
    Array.from({ length: count }, (_unused, index) => createElement(MarkdownBody, {
      key: `turn-${index}`,
      source: `${SOURCE} #${index}`,
      // The class is what the rectangle stub below reads: a body without it is at the top of the screen.
      className: index === 0 ? undefined : 'out-of-view',
      ...(hold ? { deferOffscreen: true } : {}),
    })),
  )
}

const bodies = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ink-prose')]

/** `deferOffscreen` for one body that is not near the reader. */
function heldBody(source = SOURCE): { container: HTMLElement, node: HTMLElement } {
  const container = mount(createElement(MarkdownBody, { source, className: 'out-of-view', deferOffscreen: true }))
  return { container, node: container.querySelector<HTMLElement>('.ink-prose')! }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  FakeObserver.instances = []
  passes.enhance = 0
  passes.render = 0
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  // jsdom lays nothing out, so "where is this body" is answered here: `out-of-view` puts a body two
  // screens below the reader, anything else sits at the top of it.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = this.classList?.contains('out-of-view') ? 5_000 : 0
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the hold on a body nobody is looking at', () => {
  it('draws the body in view rather than the four hundred under it, and renders every markup still', () => {
    const before = mount(createElement(Transcript, { count: 20, hold: false }))
    // The number a transcript of twenty turns cost on one mount before the hold: every body drawn.
    expect(passes.enhance).toBe(20)
    expect(passes.render, 'a body the surface never drew has no markup either, which is not the deal').toBe(20)

    act(() => root!.unmount())
    root = null
    before.remove()
    passes.enhance = 0
    passes.render = 0

    mount(createElement(Transcript, { count: 20, hold: true }))
    expect(passes.enhance, 'a held transcript still drew every body at mount').toBe(1)
    // The markup is not the work being held: the text, the anchors and the tree a search walks are all
    // there for the turns that have not been drawn yet.
    expect(passes.render, 'the hold reached past the drawing passes into the markup').toBe(20)
    expect(bodies(host!)).toHaveLength(20)
  })

  it('keeps a held body in the document, with its words, until it is asked to draw', () => {
    const { node } = heldBody()
    expect(passes.enhance, 'a held body was drawn at mount anyway').toBe(0)
    expect(node.isConnected, 'holding a body took it out of the tree').toBe(true)
    expect(node.textContent, 'a held body lost the text find, the outline and the anchors read').toContain('const answer = 42')
  })

  it('draws a held body when it arrives and never takes it back out', async () => {
    const { container, node } = heldBody()
    const observer = FakeObserver.instances.find((entry) => entry.observed.includes(node))
    expect(observer, 'nothing is watching the body for its arrival').toBeTruthy()
    expect(observer!.rootMargin, 'the hold waits until the body is already on screen to start drawing')
      .toContain('600')

    await act(async () => { observer!.report(true) })
    expect(passes.enhance, 'the body arrived and was never drawn').toBe(1)

    await act(async () => { observer!.report(false) })
    expect(node.isConnected, 'a body that scrolled away was unmounted, which breaks the DOM contracts').toBe(true)
    expect(node.textContent).toContain('const answer = 42')
    // The same element, not a fresh one with the same content: the scroll correction after "load earlier"
    // and the outline's measured rectangles are both taken from nodes that have to stay put.
    expect(container.querySelector('.ink-prose')).toBe(node)
    expect(passes.enhance, 'the drawing pass ran again for a body that only came and went').toBe(1)
    expect(observer!.disconnected, 'the observer outlived the one arrival it was made for').toBe(true)
  })

  it('draws at once on a host that cannot answer where its content is', () => {
    // The degradation the flag has to keep: no IntersectionObserver means "draw now", never "draw
    // nothing". A browser without the API, or a surface rendered outside one, gets the old behaviour.
    vi.stubGlobal('IntersectionObserver', undefined)
    const container = mount(createElement(MarkdownBody, { source: SOURCE, className: 'out-of-view', deferOffscreen: true }))
    expect(passes.enhance, 'a missing observer meant a body that is never drawn').toBe(1)
    expect(container.querySelector<HTMLElement>('.ink-prose')?.isConnected).toBe(true)
  })

  it('leaves a body that was never told to hold exactly as it was', () => {
    const container = mount(createElement(MarkdownBody, { source: SOURCE, className: 'out-of-view' }))
    expect(passes.enhance, 'a surface that passes nothing started holding its bodies').toBe(1)
    expect(FakeObserver.instances, 'a surface that passes nothing grew an observer').toHaveLength(0)
    expect(container.querySelector<HTMLElement>('.ink-prose')?.textContent).toContain('const answer = 42')
  })
})
