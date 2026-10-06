/**
 * One debounced edit re-splits the deck, and four things then ask the same question about every
 * slide — which slide is this: the cache keys, the measured plans, the measuring pass looking up
 * what it already knows, and the page on screen. Each of them used to walk the deck's text to answer
 * it on its own. The deck answers once here, so the count of hashes an edit costs is bounded by the
 * deck's page count rather than by a multiple of it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { noteSummary } from './note-fixture'
import { useNotes } from '../../store/notes'
import { usePresentation } from '../../store/presentation'
import { PresentationOverlay } from './presentation-overlay'
import { useSlideCacheKeys, useShowDeck } from './use-show-deck'
import { useSlidePlans } from './use-slide-plans'
import type { StageMetrics } from './slide-stage'

const probe = vi.hoisted(() => ({
  calls: null as (() => number) | null,
  clear: null as (() => void) | null,
  real: null as ((value: string) => string) | null,
}))

vi.mock('./slide-html', async (importOriginal) => {
  const original = await importOriginal<typeof import('./slide-html')>()
  const spy = vi.fn((value: string) => original.hashContent(value))
  probe.calls = () => spy.mock.calls.length
  probe.clear = () => { spy.mockClear() }
  probe.real = original.hashContent
  return { ...original, hashContent: spy }
})

const SLIDES = 6
const NOTE = `# Opening\n\nFirst slide text.\n\n${Array.from({ length: SLIDES - 1 }, (_, index) => `---\n\n# Slide ${index + 2}\n\nText of slide ${index + 2}.`).join('\n\n')}\n`
const EDITED = `${NOTE}\n<!-- a presenter cue added somewhere in the note -->\n`

function hashCalls(): number {
  if (!probe.calls) throw new Error('the spy is the point of these cases')
  return probe.calls()
}

function resetCount(): void {
  probe.clear?.()
}

const metrics: StageMetrics = { scale: 1, designWidth: 1280, designHeight: 720, contentWidth: 1168, contentHeight: 632 }

function Host({ content }: { content: string }) {
  const show = useShowDeck(content)
  useSlideCacheKeys(show.hashes, false, metrics)
  useSlidePlans(show.hashes)
  return createElement('span', {
    'data-slides': String(show.deck.length),
    'data-identities': String(show.hashes.length === show.deck.length && show.hashes.every((hash, at) => hash === probe.real?.(show.deck[at] ?? ''))),
    'data-summary': show.fingerprint,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useShowDeck — the identity of a slide', () => {
  beforeEach(() => {
    resetCount()
  })

  it('answers for every slide with the hash of that slide', () => {
    const view = renderElement(createElement(Host, { content: NOTE }))
    expect(view.container.querySelector('span')?.getAttribute('data-slides')).toBe(String(SLIDES))
    // The projector's key and the measuring pass's lookup are the same string only because the deck
    // answered with `hashContent` of the slide it handed out; anything else is a silent cache miss.
    expect(view.container.querySelector('span')?.getAttribute('data-identities')).toBe('true')
    view.unmount()
  })

  it('sums the deck into one identity the measuring pass restarts on', () => {
    const view = renderElement(createElement(Host, { content: NOTE }))
    const first = view.container.querySelector('span')?.getAttribute('data-summary')
    expect(first).toBeTruthy()

    view.rerender(createElement(Host, { content: EDITED }))
    expect(view.container.querySelector('span')?.getAttribute('data-summary')).not.toBe(first)
    view.unmount()
  })

  // The whole point of handing the hashes out: an edit re-splits the deck and re-identifies each
  // slide once, no matter how many surfaces then need to know which slide they are holding.
  it('walks the deck once per edit, not once per surface that asks', () => {
    const view = renderElement(createElement(Host, { content: NOTE }))
    resetCount()

    view.rerender(createElement(Host, { content: EDITED }))
    const walked = hashCalls()
    expect(view.container.querySelector('span')?.getAttribute('data-slides')).toBe(String(SLIDES))
    expect(walked, `one edit hashed ${walked} times for a deck of ${SLIDES} slides`).toBe(SLIDES + 1)
    view.unmount()
  })

  it('does not ask again when the same content renders a second time', () => {
    const view = renderElement(createElement(Host, { content: NOTE }))
    resetCount()
    view.rerender(createElement(Host, { content: NOTE }))
    expect(hashCalls()).toBe(0)
    view.unmount()
  })
})

// The show is the surface that spends these passes, so the bound is asserted where it spends them.
function startShow(content: string): void {
  useNotes.setState({ notes: { 'note-hashes': noteSummary('note-hashes', { title: 'Deck' }) }, contents: { 'note-hashes': content } })
  usePresentation.setState({ open: true, noteId: 'note-hashes', title: 'Deck', snapshot: '', following: true, initialSlideIndex: 0 })
}

function stopShow(view: RenderedElement): void {
  view.unmount()
  usePresentation.setState({ open: false, noteId: null, title: '', snapshot: '', following: false, initialSlideIndex: 0 })
  useNotes.setState({ notes: {}, contents: {} })
}

describe('a running show re-identifies its deck once per edit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  async function editTheNote(): Promise<number> {
    const view = renderElement(createElement(PresentationOverlay))
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    resetCount()
    act(() => { useNotes.setState({ contents: { 'note-hashes': EDITED } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    const calls = hashCalls()
    stopShow(view)
    return calls
  }

  it('spends no more than a deck pass and the pages it prepares', async () => {
    startShow(NOTE)
    const calls = await editTheNote()
    // One hash per slide, taken when the deck split, plus the summary the measuring pass restarts
    // on. Before the deck answered for itself the same edit cost 31: the keys, the plans, the pass
    // looking up what it had listed and the page on screen each walked it again.
    expect(calls, `one edit cost ${calls} hashes for a ${SLIDES}-slide deck`).toBe(SLIDES + 1)
  })
})
