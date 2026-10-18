// @vitest-environment jsdom
/**
 * What the assistant remembers about this page, said from the page.
 *
 * The panel already answers two questions about a note and the chat: which threads wrote it, which were
 * started from it. The third is the one a reader standing on the page asks when they have been talking to
 * the assistant about it — "what did it take away?" — and the fact that answers it has been stored the whole
 * time: `chat_memories.note_id` names this page, and only the memory page has ever read it.
 *
 * What is pinned here is the shape of the answer rather than its size. The read names this note, so a row
 * about another page cannot arrive; a refusal is reported as a refusal, because an empty list would tell the
 * reader nothing is remembered here and the request never established that; and a row is a door into the
 * assistant, where the fact can actually be corrected, rather than a second copy of the memory page inside
 * the notebook.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useAssistant } from '../chat/assistant-store'
import { BacklinksPanel } from './BacklinksPanel'

const { backlinks, noteWrites, conversations, memories } = vi.hoisted(() => ({
  backlinks: vi.fn(async () => ({ backlinks: [], unlinked: [] })),
  noteWrites: vi.fn(async () => ({ conversations: [] as { id: string, title: string, updatedAt: number }[] })),
  conversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
  memories: vi.fn(async (_params?: Record<string, string>) => ({
    memories: [] as AssistantMemory[],
    total: 0,
    counts: { active: 0, historical: 0, review: 0 },
  })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: { backlinks },
    assistant: { noteWrites, conversations, memories },
  },
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const OTHER_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz22'
const notesOriginal = useNotes.getState()
const assistantOriginal = useAssistant.getState()
let root: Root
let host: HTMLElement

function remembered(content: string, noteId: string, updatedAt: number): AssistantMemory {
  return {
    id: `m-${content.length}-${updatedAt}`,
    content,
    category: 'fact',
    source: 'assistant',
    status: 'active',
    supersededBy: null,
    validFrom: null,
    validUntil: null,
    projectId: null,
    noteId,
    createdAt: updatedAt - 10,
    updatedAt,
  }
}

/** The panel debounces the note's own backlinks, so every case pays for the same wait. */
async function show(): Promise<void> {
  await act(async () => { root.render(createElement(BacklinksPanel, { noteId: NOTE_ID })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.includes(text))
}

function namedButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({ notes: { [NOTE_ID]: { id: NOTE_ID, title: 'A note', rev: 1 } as never } })
  memories.mockResolvedValue({ memories: [], total: 0, counts: { active: 0, historical: 0, review: 0 } })
  conversations.mockResolvedValue({ conversations: [], nextCursor: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useNotes.setState(notesOriginal, true)
  useAssistant.setState(assistantOriginal, true)
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('the memories a note is the source of', () => {
  it('asks for this note alone', async () => {
    await show()
    expect(memories).toHaveBeenCalledWith(expect.objectContaining({ noteId: NOTE_ID }))
  })

  it('lists what is remembered here, newest first', async () => {
    memories.mockResolvedValue({
      memories: [
        remembered('The older fact about this page', NOTE_ID, 1_000),
        remembered('The newer fact about this page', NOTE_ID, 9_000),
        // A row that belongs to another page must not arrive; the read is the note's own.
        remembered('About something else', OTHER_NOTE, 5_000),
      ],
      total: 3,
      counts: { active: 3, historical: 0, review: 0 },
    })
    await show()
    expect(document.body.textContent).toContain(t('workspace.memories_about'))
    const newer = buttonWith('The newer fact about this page')
    const older = buttonWith('The older fact about this page')
    expect(newer && older, 'a memory is missing from the panel').toBeTruthy()
    expect(document.body.textContent).not.toContain('About something else')
    expect(newer!.compareDocumentPosition(older!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the older fact leads').toBeTruthy()
  })

  it('names the door each row is, and takes the reader into the assistant', async () => {
    memories.mockResolvedValue({
      memories: [remembered('The client pays monthly', NOTE_ID, 9_000)],
      total: 1,
      counts: { active: 1, historical: 0, review: 0 },
    })
    await show()
    const row = namedButton(`${t('workspace.open_in_assistant')}: The client pays monthly`)
    expect(row, 'the memory row has no accessible name').toBeTruthy()
    act(() => { row!.click() })
    expect(window.location.pathname).toBe('/chat')
    expect(useAssistant.getState().view).toBe('memory')
  })

  it('says the read failed, and asks again when the reader presses retry', async () => {
    memories.mockRejectedValueOnce(new Error('offline'))
    await show()
    expect(document.body.textContent).toContain(t('workspace.could_not_load_memories'))
    // Refused is not empty: the heading would be a claim about this page that the request never made.
    expect(document.body.textContent).not.toContain(t('workspace.memories_about'))
    memories.mockResolvedValue({
      memories: [remembered('Back again', NOTE_ID, 9_000)],
      total: 1,
      counts: { active: 1, historical: 0, review: 0 },
    })
    const retry = buttonWith(t('common.retry'))
    expect(retry, 'the failure offers no retry').toBeTruthy()
    await act(async () => { retry!.click() })
    expect(document.body.textContent).toContain('Back again')
    expect(document.body.textContent).not.toContain(t('workspace.could_not_load_memories'))
  })

  it('says nothing at all when nothing is remembered here', async () => {
    memories.mockResolvedValue({ memories: [], total: 0, counts: { active: 0, historical: 0, review: 0 } })
    await show()
    expect(document.body.textContent).not.toContain(t('workspace.memories_about'))
    expect(document.body.textContent).not.toContain(t('workspace.could_not_load_memories'))
  })
})
