// @vitest-environment jsdom
/**
 * The embed an answer names, drawn inside the thread.
 *
 * A reply that says "see ![[Roadmap]]" is the same sentence the note preview writes, and the reader who
 * reads it in the thread expects the same thing to arrive. Nothing else about the row explains the box:
 * left with no document to resolve against, an embed sits at "Loading" for the whole life of the answer,
 * which reads as a reply still being delivered rather than as a surface that never asked the notebook.
 * So what is pinned here is the whole shape of the promise — the body comes in, a note the vault does not
 * have is *named* rather than left waiting, and the reader's own question is held to the same line.
 *
 * The real renderer is mounted for this on purpose. A stand-in would answer nothing about whether the
 * pass that fills the box is ever started, which is exactly the defect.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { AssistantBubble } from './MessageParts'
import { UserBubble } from './ChatView'
import { useAssistant } from './assistant-store'

const { noteRead } = vi.hoisted(() => ({
  /** Every read of a note body the store has not cached — which is what an embed has to reach. */
  noteRead: vi.fn(async (_id: string) => ({ id: _id, title: 'Roadmap', content: 'Ships in October.', rev: 1 })),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      notes: { ...actual.api.notes, get: noteRead },
      files: { ...actual.api.files, byName: vi.fn(async () => ({ files: [] })) },
    },
  }
})

const ROADMAP = {
  id: 'n1',
  title: 'Roadmap',
  folderId: null,
  rev: 1,
  updatedAt: 0,
  createdAt: 0,
  deletedAt: null,
  isStarred: false,
  tags: [],
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
let root: Root
let host: HTMLElement

/** Mounts one settled answer the way the thread does. */
function drawAnswer(text: string): void {
  act(() => {
    root.render(createElement(AssistantBubble, { text, reasoning: '', tools: [], error: null, streaming: false }))
  })
}

/** Mounts the reader's own question, live turn: no row id, nothing to act on. */
function drawQuestion(text: string): void {
  act(() => { root.render(createElement(UserBubble, { text })) })
}

/**
 * What every embed box on screen currently claims about itself.
 *
 * A case about a box that never resolves is worth reading on its own: the class and the words inside are
 * the difference between "no box was drawn" and "a box is still saying Loading", and the failure should
 * not make the next reader go find out.
 */
function boxState(): string {
  const boxes = [...document.querySelectorAll<HTMLElement>('.note-embed')]
  if (!boxes.length) return 'none drawn'
  return boxes.map((box) => `${box.className.trim()} :: ${box.querySelector('.note-embed-body')?.textContent?.trim() ?? ''}`).join(' | ')
}

/**
 * Waits for the resolver's asynchronous pass to land in the DOM the row is showing.
 *
 * Every assertion below is made inside this: an embed is filled by a pass that awaits the notebook, so a
 * check taken the render after would be measuring the box before the answer arrived.
 */
async function untilDrawn(selector: string): Promise<HTMLElement> {
  let node: HTMLElement | null = null
  await act(async () => {
    await vi.waitFor(() => {
      node = document.querySelector<HTMLElement>(selector)
      expect(node, `nothing matched ${selector} in the thread; embed boxes on screen: ${boxState()}`).toBeTruthy()
    }, { timeout: 8_000, interval: 10 })
  })
  return node!
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({ notes: { n1: ROADMAP }, contents: { n1: 'Ships in October.' } } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  noteRead.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  vi.restoreAllMocks()
})

describe('an embed inside an answer', () => {
  it('brings the named note in rather than leaving its box at Loading', async () => {
    drawAnswer('The dates are in ![[Roadmap]].')
    const embed = await untilDrawn('.note-embed.ready')
    expect(embed.querySelector('.note-embed-body')?.textContent).toContain('Ships in October.')
    // The row must not keep claiming work it never started: one spinner left behind is the defect.
    expect(document.querySelector('.note-embed.loading, .note-embed [aria-busy="true"]'),
      'an embed was left waiting on a pass that never ran').toBeNull()
  })

  it('asks the notebook for a body it has not read yet', async () => {
    useNotes.setState({ notes: { n1: ROADMAP }, contents: {} } as never)
    drawAnswer('The dates are in ![[Roadmap]].')
    const embed = await untilDrawn('.note-embed.ready')
    expect(embed.querySelector('.note-embed-body')?.textContent).toContain('Ships in October.')
    expect(noteRead).toHaveBeenCalledWith('n1')
  })

  it('says plainly which embed the vault cannot answer', async () => {
    drawAnswer('See ![[Nowhere Note]] for the rest.')
    const embed = await untilDrawn('.note-embed.error')
    expect(embed.querySelector('.note-embed-body')?.textContent).toBe(t('markdown.embedded_note_not_found'))
    expect(embed.getAttribute('class'), 'a failed embed still wears the loading state').not.toContain('loading')
    expect(embed.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('resolves a self-embed against the answer it is written in', async () => {
    drawAnswer(['## Release', '', 'Everything about it is above.', '', 'See ![[#Release]].'].join('\n'))
    const embed = await untilDrawn('.note-embed.ready')
    expect(embed.querySelector('.note-embed-body')?.textContent).toContain('Everything about it is above.')
  })
})

describe("an embed inside the reader's own question", () => {
  it('brings the named note in rather than leaving its box at Loading', async () => {
    drawQuestion('Can you check ![[Roadmap]] again?')
    const embed = await untilDrawn('.note-embed.ready')
    expect(embed.querySelector('.note-embed-body')?.textContent).toContain('Ships in October.')
    expect(document.querySelector('.note-embed.loading, .note-embed [aria-busy="true"]'),
      'an embed was left waiting on a pass that never ran').toBeNull()
  })

  it('says plainly which embed the vault cannot answer', async () => {
    drawQuestion('What about ![[Nowhere Note]]?')
    const embed = await untilDrawn('.note-embed.error')
    expect(embed.querySelector('.note-embed-body')?.textContent).toBe(t('markdown.embedded_note_not_found'))
    expect(embed.querySelector('[aria-busy="true"]')).toBeNull()
  })
})
