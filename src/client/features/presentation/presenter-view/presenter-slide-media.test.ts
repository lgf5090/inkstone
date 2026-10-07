import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../../lib/test-render'
import { PresenterWindow } from './presenter-window'
import { PresenterSlidePreview } from './presenter-slide-preview'
import type { SlidePlan } from '../slide-pagination'
import type { PresenterSlideState } from './use-presenter-channel'

const SLIDE_STATE: PresenterSlideState = {
  noteTitle: 'Project Architecture',
  slideTitles: [],
  slideIndex: 1,
  subPage: 0,
  step: 0,
  steps: 0,
  slideCount: 4,
  pageCount: 1,
  currentSlideSource: '# Core Pillars\n\n- Security\n- Performance',
  nextSlideSource: '# Roadmap\n\nQ4 Deliverables',
  nextStep: 0,
  notes: 'Emphasize zero overhead and deterministic fallbacks.',
  startedAt: Date.now() - 65_000,
}

// A presenter reads the slide the room reads, so a diagram, a formula, a chart or a board has to
// arrive as a picture in this document too. The channel carries markdown and both panes paint
// through `PresenterSlidePreview`, so the enhancement the projector runs belongs there.
// Only the diagram vendor is stubbed — what these cases ask is whether this surface puts its slides
// through the enhancement at all, not what mermaid draws. The rest of the chain runs for real.
const mermaidStub = vi.hoisted(() => ({
  render: vi.fn(async (_id: string, source: string) => ({ svg: `<svg class="stub-diagram"><desc>${source}</desc></svg>` })),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: () => { },
    render: (id: string, source: string) => mermaidStub.render(id, source),
  },
}))

// Chart.js is a canvas library jsdom cannot run, so the constructor is replaced by one that records
// the canvas it was handed. What the case asks is the channel: `chart` on puts a live canvas in the
// block, `chart` off replaces the block with its fenced source, and neither can be told apart by a
// real library here.
const charts = vi.hoisted(() => ({ built: [] as HTMLCanvasElement[] }))

vi.mock('chart.js/auto', () => ({
  Chart: vi.fn(function construct(this: void, canvas: HTMLCanvasElement) {
    charts.built.push(canvas)
    return { destroy: vi.fn(), resize: vi.fn(), update: vi.fn() }
  }),
}))

// A map draws through a vendor jsdom cannot run, so its still renderer is replaced by a marker that
// records the options this surface handed it. What the case asks is the channel: `snapshot` puts the
// block through the still renderer, while a channel left unset routes it to its fence source.
const staticDraws = vi.hoisted(() => ({ mindmap: [] as Array<{ dark: boolean }> }))

vi.mock('../../../lib/markdown/mindmap/static', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/markdown/mindmap/static')>()
  return {
    ...actual,
    renderStaticMindmaps: vi.fn((root: HTMLElement, options: { dark: boolean }) => {
      staticDraws.mindmap.push({ dark: options.dark })
      for (const node of root.querySelectorAll<HTMLElement>('[data-mindmap]')) {
        node.classList.remove('loading')
        node.innerHTML = '<svg class="stub-map"></svg>'
      }
      return Promise.resolve()
    }),
  }
})

const DIAGRAM_SLIDE = ['# Flow', '', '```mermaid', 'flowchart LR', '  A --> B', '```', ''].join('\n')
const NEXT_DIAGRAM_SLIDE = ['# Elsewhere', '', '```mermaid', 'flowchart LR', '  A --> C', '```', ''].join('\n')
const FORMULA_SLIDE = 'Energy: $E=mc^2$\n'
const CHART_SLIDE = ['```chart', '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}', '```', ''].join('\n')
const BOARD_SLIDE = ['```kanban', JSON.stringify({
  title: 'Release plan',
  activeViewId: 'view-board',
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  ],
  views: [{ id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' }],
  items: [{ id: 'i1', title: 'Tag the build', properties: { status: 'todo' } }],
}), '```', ''].join('\n')
const MAP_SLIDE = ['# Topics', '', '```mindmap', '# Roadmap', '## Now', '```', ''].join('\n')

// The enhancement is a chain of dynamic imports, so a case waits for the block it asked about rather
// than for a fixed number of ticks. Running out the rounds leaves the assertion to fail on the block
// that never arrived, which is the defect this item is about.
async function untilDrawn(found: () => boolean): Promise<void> {
  for (let round = 0; round < 150 && !found(); round++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  expect(found(), 'the presenter left its slide in the placeholder state').toBe(true)
}

describe('PresenterSlidePreview — the blocks it draws', () => {
  it('draws the diagram the slide carries instead of leaving its placeholder', async () => {
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: DIAGRAM_SLIDE }))
    await untilDrawn(() => Boolean(container.querySelector('[data-mermaid] svg.stub-diagram')))
    expect(container.querySelector('desc')?.textContent).toContain('A --> B')
    unmount()
  })

  it('sets the formula the slide carries instead of showing its source', async () => {
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: FORMULA_SLIDE }))
    await untilDrawn(() => Boolean(container.querySelector('.katex')))
    expect(container.querySelector('.katex')?.textContent).toContain('E')
    unmount()
  })
})

describe('PresenterSlidePreview — a chart and a board', () => {
  it('draws the chart on a live canvas instead of the fenced source', async () => {
    const before = charts.built.length
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: CHART_SLIDE }))
    try {
      await untilDrawn(() => Boolean(container.querySelector('[data-chart] canvas')))
      expect(charts.built.length, 'the presenter asked chart.js for an instance').toBe(before + 1)
      const block = container.querySelector<HTMLElement>('[data-chart]')
      expect(block?.classList.contains('has-error')).toBe(false)
      expect(block?.dataset.rendered).toBeTruthy()
    }
    finally {
      unmount()
    }
  })

  it('draws a board as its cards, reading the fence bodies its own markup came from', async () => {
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: BOARD_SLIDE }))
    await untilDrawn(() => Boolean(container.querySelector('[data-kanban] .kanban-snapshot')))
    expect(container.querySelector('.kanban-snapshot')?.textContent).toContain('Tag the build')
    unmount()
  })

  it('keeps reading those bodies when the pane shows one page of a longer slide', async () => {
    // The pane slices the markup to the page the show is on, while the fence bodies belong to the
    // whole slide: a slice that carries its blocks without their bodies draws an empty board.
    const plan: SlidePlan = { pages: [{ from: 0, to: 1, top: 0 }, { from: 1, to: 2, top: 400 }], scales: [1, 1] }
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: `Opening line.\n\n${BOARD_SLIDE}`, plan, sub: 1 }))
    await untilDrawn(() => Boolean(container.querySelector('[data-kanban] .kanban-snapshot')))
    expect(container.querySelector('.kanban-snapshot')?.textContent).toContain('Tag the build')
    expect(container.textContent).not.toContain('Opening line.')
    unmount()
  })

  it('lays the slide out on the design canvas the projector shows it on', async () => {
    // This fork's map and board stills measure the DOM box they are drawn into rather than being
    // handed one, so the box the pane has to provide is the slide's own design width — not the few
    // hundred pixels the presenter pane happens to be.
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: MAP_SLIDE }))
    await untilDrawn(() => Boolean(container.querySelector('[data-mindmap] svg.stub-map')))
    const canvas = container.querySelector<HTMLElement>('.ink-slide')
    expect(Number(canvas?.style.width.replace('px', ''))).toBe(1280)
    unmount()
  })
})

describe('PresenterSlidePreview — the still-image channel', () => {
  it('hands a map to the snapshot renderer under the theme on screen', async () => {
    document.documentElement.dataset.theme = 'light'
    const { container, unmount } = renderElement(createElement(PresenterSlidePreview, { source: MAP_SLIDE }))
    await untilDrawn(() => Boolean(container.querySelector('[data-mindmap] svg.stub-map')))
    const drawn = staticDraws.mindmap.at(-1)
    expect(drawn?.dark).toBe(false)
    unmount()
    delete document.documentElement.dataset.theme
  })
})

describe('PresenterWindow — both panes run the enhancement', () => {
  it('draws the diagram of the slide the presenter walked on to, not only the first one', async () => {
    const state: PresenterSlideState = {
      ...SLIDE_STATE,
      currentSlideSource: DIAGRAM_SLIDE,
      nextSlideSource: NEXT_DIAGRAM_SLIDE,
    }
    const { container, rerender, unmount } = renderElement(createElement(PresenterWindow, { initialState: state }))
    await untilDrawn(() => Boolean(container.querySelector('[data-mermaid] svg.stub-diagram')))
    // A second slide the channel reports has to be drawn as well: an enhancement that only ever
    // looked at the markup it first met is what this case pins.
    rerender(createElement(PresenterWindow, {
      initialState: { ...state, currentSlideSource: NEXT_DIAGRAM_SLIDE },
    }))
    await untilDrawn(() => [...container.querySelectorAll('[data-mermaid] desc')].some((node) => node.textContent?.includes('A --> C')))
    unmount()
  })

  it('draws a diagram in the next-slide pane as well as the current one', async () => {
    const state: PresenterSlideState = {
      ...SLIDE_STATE,
      currentSlideSource: DIAGRAM_SLIDE,
      nextSlideSource: DIAGRAM_SLIDE,
    }
    const { container, unmount } = renderElement(createElement(PresenterWindow, { initialState: state }))
    await untilDrawn(() => container.querySelectorAll('[data-mermaid] svg.stub-diagram').length >= 2)
    expect(container.querySelectorAll('[data-mermaid] svg.stub-diagram')).toHaveLength(2)
    unmount()
  })
})
