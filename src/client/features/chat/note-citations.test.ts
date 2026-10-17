// @vitest-environment jsdom
/**
 * Where a citation leads.
 *
 * An answer can be built on two different things: pages a web search found, and notes the note tools read.
 * They are drawn side by side, so the only thing that keeps them apart is what the card does when it is
 * pressed — and that difference is the whole point. A note citation is a button that opens the note in
 * this vault; a web citation is a link that leaves. Getting them the wrong way round sends a reader to a
 * new tab for a note they already have, or worse, nowhere at all.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSource } from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { AssistantBubble } from './MessageParts'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: { notes: { get: vi.fn(async () => null) } },
}))

const NOTE: AssistantSource = {
  url: '/n/01hzzzzzzzzzzzzzzzzzzzzz11',
  title: 'Quarterly plan',
  kind: 'note',
  id: '01hzzzzzzzzzzzzzzzzzzzzz11',
  cited: 'the part about hiring',
}

const WEB: AssistantSource = { url: 'https://example.com/a', title: 'A page' }

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
let root: Root
let host: HTMLElement

function render(sources: AssistantSource[]): HTMLElement {
  root = createRoot(host)
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'It says so in your notes.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      sources,
    }))
  })
  return host
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  vi.restoreAllMocks()
})

describe('the citations beside an answer', () => {
  it('draws a note as a card that opens it, not as a link off the app', () => {
    const view = render([NOTE])
    expect(view.querySelector('a')).toBeNull()
    const card = view.querySelector('button[title="the part about hiring"]')
    expect(card, 'the note citation is not drawn as a button').toBeTruthy()
    expect(card!.textContent).toContain('Quarterly plan')
  })

  it('opens the note when the card is pressed', () => {
    const openNote = vi.fn(async () => undefined)
    // The citation is followed only for a note the vault still has, so the fixture has to carry the row
    // the guard reads — a bare `openNote` mock would answer "that note is gone" and never reach it.
    useNotes.setState({ openNote, notes: { [NOTE.id!]: { id: NOTE.id, title: NOTE.title, deletedAt: null } as never } })
    const view = render([NOTE])
    act(() => { (view.querySelector('button[title="the part about hiring"]') as HTMLButtonElement).click() })
    // A single-pane layout has nowhere else to put it, so the note takes the reader there.
    expect(openNote).toHaveBeenCalledWith(NOTE.id, { pane: 'primary', activate: true })
  })

  it('leaves a web page a link in a new tab', () => {
    const view = render([WEB])
    const link = view.querySelector('a')
    expect(link, 'the web citation is not drawn as a link').toBeTruthy()
    expect(link!.getAttribute('href')).toBe(WEB.url)
    expect(link!.getAttribute('rel')).toContain('noreferrer')
  })
})
