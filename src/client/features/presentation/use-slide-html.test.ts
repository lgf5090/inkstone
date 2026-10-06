/**
 * Preparing a page means running its diagrams, math and embeds into the markup the projector will
 * actually show. Two things can go wrong on the way there, and both used to end the same way: the
 * page keeps its text and loses everything drawn, with nothing to tell "slow" from "this one is
 * never coming". When that chain throws, the page still has to say so; when a run is interrupted —
 * the presenter turned the page, or a keystroke landed somewhere else in the note — the page has to
 * be prepared again rather than left holding the plain markup forever.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import type { PreviewSettings } from '@shared/types'
import { createFenceBodies } from '../../lib/markdown/fence-bodies'
import { clearSlideHtmlCache, hashContent, readSlideHtml, rememberSlideHtml, slideCacheKey } from './slide-html'

const prep = vi.hoisted(() => ({
  calls: 0,
  pending: [] as Array<() => void>,
  mode: 'ok' as 'ok' | 'throw',
}))

vi.mock('../../lib/markdown/enhance', () => ({
  enhancePreview: vi.fn(async (host: HTMLElement) => {
    prep.calls += 1
    // A run waits here until the case hands it its answer, so a case can put a page change or a
    // keystroke in the middle of it — which is the whole subject of these assertions.
    await new Promise<void>((resolve) => { prep.pending.push(resolve) })
    if (prep.mode === 'throw') throw new Error('a diagram blew up')
    host.innerHTML = '<h1>Prepared</h1>'
  }),
}))

vi.mock('../../lib/markdown/embeds', () => ({
  resolveNoteEmbeds: vi.fn(async () => {}),
}))

const { useSlideHtml } = await import('./use-slide-html')

const DECK = ['# Opening\n\nSome text', '# Second\n\nMore text']
const NOTE = DECK.join('\n\n---\n\n')
const metrics = { contentWidth: 1120, contentHeight: 630, designWidth: 1280, designHeight: 720, scale: 1 }

function Host({ index, deck = DECK, content = NOTE }: { index: number; deck?: string[]; content?: string }) {
  const failed = useSlideHtml({
    open: true,
    deck,
    hashes: deck.map(hashContent),
    index,
    content,
    noteTitle: 'Talk',
    dark: false,
    metrics,
  })
  return createElement('span', { 'data-failed': String(failed) })
}

let warnings: unknown[][] = []

// A run finishes in a chain of microtasks, so the flush that lets a case read what landed has to
// cross a task boundary rather than count hops.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await Promise.resolve()
  })
}

async function finishRun(index: number): Promise<void> {
  const resolve = prep.pending[index]
  if (!resolve) throw new Error(`run ${index + 1} never started`)
  act(() => { resolve() })
  await settle()
}

function preparedHtml(index: number): string | undefined {
  return readSlideHtml(keyFor(index))?.html
}

function keyFor(index: number): string {
  return slideCacheKey({ fingerprint: hashContent(DECK[index] ?? ''), dark: false, index, contentWidth: metrics.contentWidth, contentHeight: metrics.contentHeight })
}

/** Writes the account's own display settings, the way the settings panel does. */
function turnSetting(patch: Partial<PreviewSettings>): void {
  act(() => {
    useSession.setState((state) => ({ ...state, settings: { ...state.settings, preview: { ...state.settings.preview, ...patch } } }))
  })
}

beforeEach(() => {
  clearSlideHtmlCache()
  prep.calls = 0
  prep.pending = []
  prep.mode = 'ok'
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...rest: unknown[]) => { warnings.push(rest) })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('useSlideHtml — the settings a page was prepared under', () => {
  it('prepares the page again when the account turns its diagrams off mid-show', async () => {
    // The enhancement chain reads `math` / `mermaid` / `chart` out of the account's own
    // settings, and the canvas's diagram pass honours them too, so a page prepared for one set of them
    // is not the page the room is asking for after the presenter turns one off. It used to be left
    // alone forever: the cache is keyed without them, so the entry the flip pointed at was already
    // `prepared` and the early return said there was nothing to do (L-16).
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)
    expect(preparedHtml(0)).toContain('Prepared')
    expect(prep.calls).toBe(1)

    turnSetting({ mermaid: false })
    await settle()
    expect(prep.calls, 'a page prepared for the other settings is not prepared for these').toBe(2)
    await finishRun(1)
    expect(preparedHtml(0), 'and the replacement is what the surfaces read from then on').toContain('Prepared')
    view.unmount()
  })

  it('leaves a prepared page alone when the setting it turned never reached the slide', async () => {
    // The other half of the same rule: a flip of something the slide does not read must not re-render
    // the deck a presenter is standing on. `codeBlockCollapse` is the account's note setting, and a
    // slide prints its code fences collapsed by the constant the preparation passes down.
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)
    expect(prep.calls).toBe(1)

    turnSetting({ codeBlockCollapse: !useSession.getState().settings.preview.codeBlockCollapse })
    await settle()
    expect(prep.calls, 'nothing about this page changed, so nothing is prepared again').toBe(1)
    view.unmount()
  })
})

describe('useSlideHtml — when a page cannot be prepared', () => {
  it('warns with context instead of dropping the rejection', async () => {
    prep.mode = 'throw'
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)

    expect(warnings.length).toBe(1)
    expect(String(warnings[0]?.[0])).toContain('[inkstone] slide preparation failed')
    view.unmount()
  })

  it('reports the page it could not prepare and not the one that came through', async () => {
    prep.mode = 'throw'
    // The second page is seeded as already prepared, so its effect has nothing to run: a report that
    // named every page would call this one broken too, and that is the difference between a notice
    // and an alarm.
    rememberSlideHtml(keyFor(1), { html: '<p>More text</p>', fences: createFenceBodies(), prepared: true })

    const prepared: RenderedElement = renderElement(createElement(Host, { index: 1 }))
    await settle()
    expect(prepared.container.querySelector('span')?.getAttribute('data-failed')).toBe('false')
    prepared.unmount()

    const broken: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)
    expect(broken.container.querySelector('span')?.getAttribute('data-failed')).toBe('true')
    broken.unmount()
  })

  // The plain markup is written before the enhancement runs, so a failed page still carries its text;
  // the failure rides along beside it, which is what lets the slide list and the projector agree.
  it('leaves the readable markup in the cache with the failure marked on it', async () => {
    prep.mode = 'throw'
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)

    const entry = readSlideHtml(keyFor(0))
    expect(entry?.failed).toBe(true)
    expect(entry?.html).toContain('Some text')
    view.unmount()
  })
})

describe('useSlideHtml — what a failed page keeps', () => {
  // A page that failed is not tried again every time the canvas is put back where it was: the report
  // the presenter is shown would otherwise flicker with each remount of the show.
  it('does not start a second run for a page it already called broken', async () => {
    prep.mode = 'throw'
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)
    expect(prep.calls).toBe(1)
    view.unmount()

    const again: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await settle()
    expect(prep.calls).toBe(1)
    expect(again.container.querySelector('span')?.getAttribute('data-failed')).toBe('true')
    again.unmount()
  })
})

describe('useSlideHtml — a preparation that was interrupted', () => {
  // Turning the page cancels the run behind it, and the plain markup the run had already cached is
  // not the finished page. Coming back has to start again — otherwise the slide keeps the loading
  // placeholders of a run nobody finished, for every visit the rest of the talk makes.
  it('prepares the page again when the presenter comes back to it', async () => {
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    expect(prep.calls).toBe(1)

    view.rerender(createElement(Host, { index: 1 }))
    expect(prep.calls).toBe(2)
    await finishRun(0)

    view.rerender(createElement(Host, { index: 0 }))
    expect(prep.calls).toBe(3)
    await finishRun(2)
    expect(preparedHtml(0)).toContain('Prepared')
    view.unmount()
  })

  // An edit in another slide hands the show a new deck array and new note text, and changes nothing
  // about the page on screen. It must not be read as a reason to stop preparing that page.
  it('lets the page on screen finish when the keystroke landed in a different slide', async () => {
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    expect(prep.calls).toBe(1)

    const edited = [...DECK]
    edited[1] = '# Second\n\nMore text, and a new line'
    view.rerender(createElement(Host, { index: 0, deck: edited, content: `${edited[0]}\n\n---\n\n${edited[1]}` }))
    await finishRun(0)

    expect(prep.calls).toBe(1)
    expect(preparedHtml(0)).toContain('Prepared')
    view.unmount()
  })

  // The other half of the same rule: when the page's own text is what changed, that is a different
  // page, and it gets its own run.
  it('starts a run for the page the edit actually moved', async () => {
    const view: RenderedElement = renderElement(createElement(Host, { index: 0 }))
    await finishRun(0)
    expect(prep.calls).toBe(1)

    const edited = [...DECK]
    edited[0] = '# Opening\n\nSome text, and a new line'
    view.rerender(createElement(Host, { index: 0, deck: edited, content: `${edited[0]}\n\n---\n\n${edited[1]}` }))
    expect(prep.calls).toBe(2)
    view.unmount()
  })
})
