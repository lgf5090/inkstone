import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubWideShow, type RenderedElement } from '../../lib/test-render'
import { mergeSettings } from '@shared/constants'
import { useSession } from '../../store/session'
import { usePresentation } from '../../store/presentation'
import { PresentationOverlay } from './presentation-overlay'
import { useChromeAutoHide } from './use-chrome-auto-hide'

// Three switches the account owns over what a show looks like. Each is asserted where it is felt,
// because a setting nothing reads still renders a perfectly good toggle.
const CHART_SLIDE = ['# Numbers', '', '```chart', '{"type":"bar","data":{"labels":["A","B"],"datasets":[{"data":[1,2]}]}}', '```', ''].join('\n')
const DECK = '# One\n\nContent\n\n---\n\n# Two'

const charts = vi.hoisted(() => ({ built: [] as Array<{ canvas: HTMLCanvasElement, config: Record<string, unknown> }> }))

vi.mock('chart.js/auto', () => ({
  Chart: vi.fn(function construct(this: void, canvas: HTMLCanvasElement, config: Record<string, unknown>) {
    charts.built.push({ canvas, config })
    return { destroy: vi.fn(), resize: vi.fn(), update: vi.fn() }
  }),
}))

beforeAll(async () => {
  await initI18n()
})

// The overlay is a portal on `document.body` and it outlives the case that opened it unless it is
// unmounted by name. Clearing `document.body` would leave the root live, and its next effect would
// then run against the globals the teardown has already taken away.
let view: RenderedElement | null = null

function show(): RenderedElement {
  view = renderElement(createElement(PresentationOverlay))
  return view
}

function setPreview(patch: Record<string, unknown>): void {
  useSession.setState((state) => ({ ...state, settings: { ...state.settings, preview: { ...state.settings.preview, ...patch } } }))
}

function controlNamed(label: string): HTMLButtonElement | undefined {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-presentation-chrome] button')]
  return buttons.find((item) => item.getAttribute('aria-label') === label)
}

async function settle(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

beforeEach(() => {
  charts.built.length = 0
  setPreview({ presentationSlideList: true, presentationChartAnimation: true, presentationAutoHideChrome: true })
  usePresentation.setState({ open: true, noteId: 'note-settings', title: 'Settings', snapshot: DECK, following: false, initialSlideIndex: 0, startedAt: Date.now() })
})

afterEach(() => {
  act(() => {
    view?.unmount()
    view = null
    usePresentation.setState({ open: false, noteId: null, snapshot: '' })
  })
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the slide list a show opens with', () => {
  it('is beside the projector when the account asks for it in a room with space', () => {
    stubWideShow()
    show()
    expect(document.querySelector('[data-presentation-rail]')).not.toBeNull()
  })

  it('is absent in the same room when the account turned it off', () => {
    stubWideShow()
    setPreview({ presentationSlideList: false })
    show()
    expect(document.querySelector('[data-presentation-rail]'), 'space on the wall is not a reason to show it').toBeNull()
  })

  it('is still one press away for the show that is already running', () => {
    stubWideShow()
    setPreview({ presentationSlideList: false })
    show()
    const toggle = controlNamed(t('workspace.presentation_show_slides'))
    expect(toggle, 'the control says what it will do').toBeDefined()
    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(document.querySelector('[data-presentation-rail]')).not.toBeNull()
  })
})

describe('the chart animation switch', () => {
  // The projector and the slide list both draw this chart, and a thumbnail is always drawn at
  // once whatever the account says — so the answer has to come from the canvas inside the projector,
  // not from whichever chart was built last.
  async function projectorChartConfig(): Promise<Record<string, unknown>> {
    stubWideShow()
    usePresentation.setState({ snapshot: CHART_SLIDE })
    show()
    const stage = () => document.querySelector('[role="dialog"] [data-slide-canvas] [data-chart] canvas')
    for (let round = 0; round < 60 && !stage(); round++) await settle(1)
    const canvas = stage()
    expect(canvas, 'the projector drew the chart at all').not.toBeNull()
    const built = charts.built.find((entry) => entry.canvas === canvas)
    expect(built, 'the projector canvas was the one handed to chart.js').toBeTruthy()
    return built!.config
  }

  it('lets a chart play its entrance when the account left animation on', async () => {
    const config = await projectorChartConfig()
    expect((config.options as Record<string, unknown>).animation).not.toBe(false)
  })

  it('hands the projector an already-drawn chart when the account turned it off', async () => {
    setPreview({ presentationChartAnimation: false })
    const config = await projectorChartConfig()
    expect((config.options as Record<string, unknown>).animation).toBe(false)
  })
})

describe('idle hiding, which is what the chrome switch turns off', () => {
  function Harness({ active }: { active: boolean }): ReturnType<typeof createElement> {
    const hidden = useChromeAutoHide(active)
    return createElement('span', { 'data-hidden': String(hidden) })
  }

  it('fades the chrome after the idle window while the show owns the screen', () => {
    vi.useFakeTimers()
    const { container, unmount } = renderElement(createElement(Harness, { active: true }))
    try {
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(container.querySelector('[data-hidden="true"]')).not.toBeNull()
    }
    finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('never fades it when the surface says it is not that kind of show', () => {
    vi.useFakeTimers()
    const { container, unmount } = renderElement(createElement(Harness, { active: false }))
    try {
      act(() => { vi.advanceTimersByTime(120_000) })
      expect(container.querySelector('[data-hidden="true"]'), 'a pinned control bar stays put however long the room is quiet').toBeNull()
    }
    finally {
      unmount()
      vi.useRealTimers()
    }
  })
})

describe('the three switches survive a round trip through the settings validator', () => {
  it('keeps false stored as false rather than falling back to the default', () => {
    const merged = mergeSettings({
      preview: { presentationSlideList: false, presentationChartAnimation: false, presentationAutoHideChrome: false },
    })
    expect(merged.preview.presentationSlideList).toBe(false)
    expect(merged.preview.presentationChartAnimation).toBe(false)
    expect(merged.preview.presentationAutoHideChrome).toBe(false)
  })

  it('ignores a non-boolean answer instead of storing a truthy string', () => {
    expect(mergeSettings({ preview: { presentationSlideList: 'yes' } }).preview.presentationSlideList).toBe(true)
  })

  it('gives an account that never chose the defaults it expects', () => {
    const merged = mergeSettings({})
    expect(merged.preview.presentationSlideList).toBe(true)
    expect(merged.preview.presentationChartAnimation).toBe(true)
    expect(merged.preview.presentationAutoHideChrome).toBe(true)
  })
})
