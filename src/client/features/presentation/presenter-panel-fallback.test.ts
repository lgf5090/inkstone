import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubWideShow, type RenderedElement } from '../../lib/test-render'
import { noteSummary } from './note-fixture'
import { useNotes } from '../../store/notes'
import { usePresentation } from '../../store/presentation'
import { useUi } from '../../store/ui'
import { PresentationOverlay } from './presentation-overlay'

beforeEach(async () => {
  await initI18n()
  // The one entry precondition `startPresentationFromNote` enforces: the show is started from a note
  // the store has. Without a summary here the overlay would read the show as one whose note has gone.
  useNotes.setState({ notes: { [SHOW.noteId]: noteSummary(SHOW.noteId, { title: SHOW.title }) }, contents: {} })
  // The console this case reaches is the wide bar's button; on a phone it lives behind the door.
  stubWideShow()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  view?.unmount()
  view = null
  act(() => {
    usePresentation.getState().stop()
  })
  useNotes.setState({ notes: {}, contents: {} })
  useUi.setState({ toasts: [] })
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const SHOW = {
  noteId: 'note-fallback',
  title: 'Fallback',
  content: '# One\n\n<!-- note: opening line -->\n\n---\n\n# Two\n\n<!-- note: the middle -->\n\n---\n\n# Three\n\n<!-- note: closing line -->',
}

// The shell hosts the overlay for the whole session, so one mount stands for the app and `start()`
// is a talk: a second show must be the same surface seeing the store change, not a fresh mount.
let view: RenderedElement | null = null

// The slide markup is rendered off-DOM and lands a microtask after the drive that asked for it, so
// every drive here is an async `act` that lets that update arrive while React is still listening.
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function startShow() {
  if (!view) view = renderElement(createElement(PresentationOverlay))
  await act(async () => {
    usePresentation.getState().start(SHOW)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function pressPresenter() {
  const button = document.querySelector<HTMLButtonElement>(`[data-presentation-chrome] [aria-label="${t('workspace.presentation_presenter')}"]`)
  expect(button, 'the show’s own presenter button has to be there to press').toBeTruthy()
  await act(async () => {
    button?.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function turnThePage() {
  const button = document.querySelector<HTMLButtonElement>(`[data-presentation-chrome] [aria-label="${t('workspace.presentation_next')}"]`)
  expect(button, 'the projector has to be turnable to see whether the panel follows').toBeTruthy()
  await act(async () => {
    button?.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function stopShow() {
  await act(async () => {
    usePresentation.getState().stop()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function pressClose() {
  const close = document.querySelector<HTMLButtonElement>(`[data-presenter-panel] [aria-label="${t('common.close')}"]`)
  expect(close, 'the panel has to be dismissable from inside it').toBeTruthy()
  await act(async () => {
    close?.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function panelText(): string | undefined {
  return document.querySelector('[data-presenter-panel]')?.textContent
}

function lastToastTitle(): string | undefined {
  return useUi.getState().toasts.at(-1)?.title
}

describe('a presenter console the browser will not open', () => {
  it('says why nothing appeared, in a toast rather than in silence', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await startShow()
    await pressPresenter()
    expect(lastToastTitle(), 'a blocked popup was swallowed without a word to the speaker').toBe(t('workspace.presentation_popup_blocked'))
    expect(useUi.getState().toasts.at(-1)?.tone).toBe('warning')
  })

  it('puts the console in this window instead, and keeps it in step with the projector', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await startShow()
    await pressPresenter()
    expect(panelText(), 'the fallback panel never mounted').toContain('Two')
    expect(panelText()).toContain('opening line')
    await turnThePage()
    expect(panelText(), 'the panel kept the page the show moved off').toContain('Three')
    expect(panelText()).toContain('the middle')
  })

  it('opens no panel and says nothing when the window does open', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window)
    await startShow()
    await pressPresenter()
    expect(document.querySelector('[data-presenter-panel]')).toBeNull()
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('takes the panel down with the show, so the next talk does not inherit it', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await startShow()
    await pressPresenter()
    expect(panelText()).toBeTruthy()
    await stopShow()
    await startShow()
    expect(panelText(), 'a fresh show reopened the panel the last one ended with').toBeUndefined()
  })

  it('lets the speaker put it away', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await startShow()
    await pressPresenter()
    await pressClose()
    await settle()
    expect(document.querySelector('[data-presenter-panel]')).toBeNull()
  })
})
