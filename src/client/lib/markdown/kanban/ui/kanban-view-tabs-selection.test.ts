/**
 * The selected view tab used to be `--bg-raised` on a header of `--bg-surface`, and on both light
 * themes those two tokens are the same colour (`oklch(100% 0 0)` on the warm paper theme, `#ffffff`
 * on the system one) — so on a light theme the strip showed no selection at all (user report
 * 2026-09-23: the inline board shows which tab is active and the full screen one does not). The pair
 * that says "this is the current one" everywhere else in the app is the accent on its own tint, which
 * is also the pairing the token layer calibrates for every accent.
 *
 * What a jsdom case can hold is the token choice and the invariant that goes with it — the selection
 * is not painted in a token the header itself uses — because jsdom computes no colours. The colours
 * themselves are measured on the real screen: `check-contrast.mjs` reads the board's painted accent
 * (the surface declares that family now) in both themes, and `e2e-visual.mjs` measures the selected
 * tab's own background against the colour already behind it, in the note and in the overlay.
 *
 * The strip is also where a board with more views than fit has to own up to where the selected one
 * went: it scrolls, and the tab the reader just selected has to be brought back into it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanView } from '../types'
import { KanbanViewTabs, type KanbanViewOperations } from './kanban-view-tabs'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const views: KanbanView[] = [
  { id: 'v-board', name: 'Board', type: 'board' },
  { id: 'v-timeline', name: 'Timeline', type: 'timeline' },
  { id: 'v-gantt', name: 'Gantt', type: 'gantt' },
]

const PANEL_ID = 'kanban-view-panel'

const mounted: ReturnType<typeof renderElement>[] = []

function mount(node: Parameters<typeof renderElement>[0]) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function viewOperations(overrides: Partial<KanbanViewOperations> = {}): KanbanViewOperations {
  return {
    createView: vi.fn(),
    renameView: vi.fn(),
    duplicateView: vi.fn(),
    deleteView: vi.fn(),
    moveView: vi.fn(),
    ...overrides,
  }
}

function mountTabs(activeViewId: string) {
  const rendered = mount(
    createElement(KanbanViewTabs, {
      views,
      activeViewId,
      panelId: PANEL_ID,
      onSelectView: vi.fn(),
      viewOps: viewOperations(),
    }),
  )
  const tabs = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')]
  return { ...rendered, tabs }
}

/** The scrolling row itself, which is the tablist and nothing else in this strip. */
function stripOf(container: ParentNode): HTMLElement {
  const strip = container.querySelector<HTMLElement>('[role="tablist"]')
  expect(strip, 'the view switcher is no longer a tablist').not.toBeNull()
  return strip!
}

/** The tokens a class string paints with, in declaration order. */
function tokensOf(node: HTMLElement): string[] {
  return [...(node.className || '').toString().matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!)
}

describe('the selected tab is painted, in both themes', () => {
  it('paints the selection with the accent pair the app uses for the current one', () => {
    const { container } = mountTabs('v-timeline')
    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
    expect(selected.textContent).toContain('Timeline')
    expect(tokensOf(selected)).toContain('--accent')
    expect(tokensOf(selected)).toContain('--accent-soft')
  })

  it('does not paint the selection in the surface the header itself is drawn on', () => {
    const { container } = mountTabs('v-timeline')
    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
    const headerTokens = ['--bg-surface', '--bg-raised']
    const painted = tokensOf(selected).filter((token) => headerTokens.includes(token))
    expect(painted, 'a tab painted in the header\'s own background is invisible on a light theme').toEqual([])
  })

  it('keeps the unselected tabs plain, so the selection is the only accented one', () => {
    const { tabs } = mountTabs('v-timeline')
    const unselected = tabs.filter((tab) => tab.getAttribute('aria-selected') !== 'true')
    expect(unselected.length).toBeGreaterThan(1)
    for (const tab of unselected) {
      expect(tokensOf(tab), `the "${tab.textContent}" tab wears the selection`).not.toContain('--accent-soft')
    }
  })
})

describe('the strip brings the selected tab into view', () => {
  /** jsdom lays nothing out, so the geometry a strip would have is given to the element it is on. */
  function layout(strip: HTMLElement, tab: HTMLElement, geometry: { left: number; width: number; view: number; scroll: number }) {
    Object.defineProperty(tab, 'offsetLeft', { value: geometry.left, configurable: true })
    Object.defineProperty(tab, 'offsetWidth', { value: geometry.width, configurable: true })
    Object.defineProperty(strip, 'clientWidth', { value: geometry.view, configurable: true })
    strip.scrollLeft = geometry.scroll
    return strip
  }

  function mountStrip(activeViewId: string) {
    const viewOps = viewOperations()
    const element = (id: string) =>
      createElement(KanbanViewTabs, { views, activeViewId: id, panelId: PANEL_ID, onSelectView: vi.fn(), viewOps })
    const rendered = mount(element(activeViewId))
    const strip = stripOf(rendered.container)
    const tab = rendered.container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
    return { ...rendered, strip, tab, element }
  }

  it('scrolls the strip right when the selected tab sits past its end', () => {
    const { strip, tab, element, rerender } = mountStrip('v-board')
    layout(strip, tab, { left: 500, width: 80, view: 200, scroll: 0 })
    rerender(element('v-board'))
    expect(strip.scrollLeft).toBe(380)
  })

  it('scrolls the strip back when the selected tab sits before its start', () => {
    const { strip, tab, element, rerender } = mountStrip('v-board')
    layout(strip, tab, { left: 40, width: 60, view: 200, scroll: 300 })
    rerender(element('v-board'))
    expect(strip.scrollLeft).toBe(40)
  })

  it('leaves the strip where it is when the selected tab is already visible', () => {
    const { strip, tab, element, rerender } = mountStrip('v-board')
    layout(strip, tab, { left: 120, width: 60, view: 200, scroll: 100 })
    rerender(element('v-board'))
    expect(strip.scrollLeft).toBe(100)
  })

  it('follows the selection when the reader switches views', () => {
    const { strip, container, element, rerender } = mountStrip('v-board')
    const target = container.querySelector<HTMLElement>('[role="tab"][data-view-type="gantt"]')!
    layout(strip, target, { left: 640, width: 70, view: 200, scroll: 0 })
    rerender(element('v-gantt'))
    expect(strip.scrollLeft).toBe(510)
  })

  it('re-reveals the selected tab when the strip changes size with no render in between', () => {
    // The note and the overlay lay the same elements out at different widths, and the elements move
    // between them without re-running a React effect. A scrollLeft clamped while the strip was still
    // at its transient width (here: 64 − 49) survives the move and cuts the selected first tab on its
    // left; the ResizeObserver is what runs the reveal again once the strip settles at its new width.
    let fire: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          fire = callback
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    try {
      const { strip, tab } = mountStrip('v-board')
      layout(strip, tab, { left: 0, width: 64, view: 179, scroll: 15 })
      expect(strip.scrollLeft).toBe(15)
      act(() => {
        fire?.()
      })
      expect(strip.scrollLeft, 'the strip let go of the scroll the transient layout left behind').toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
