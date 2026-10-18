// @vitest-environment jsdom
/**
 * The page a fact came from, from the fact's own side.
 *
 * `chat_memories.note_id` names the note a fact was written out as, and the row has always had a button
 * that claims to open it. What it never had was an answer for the page being gone. The notebook's purge
 * clears the pointer, but a note sitting in the trash, a restore that brought the facts without the pages,
 * and a second device that has not caught up all leave the row pointing at a note that cannot be opened —
 * and the button then promises a door with nothing behind it.
 *
 * Three things are pinned: the entry names the page it opens, a missing page is said out loud instead of
 * offered as a link, and the state is not guessed from a list the browser has not read yet.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { MemoryView } from './MemoryView'
import { useAssistant } from './assistant-store'

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz55'

const { memoryNote, openNote, served } = vi.hoisted(() => {
  const memory: AssistantMemory = {
    id: 'm1',
    content: 'The budget review is monthly',
    category: 'fact',
    source: 'assistant',
    status: 'active',
    supersededBy: null,
    validFrom: null,
    validUntil: null,
    projectId: null,
    noteId: null,
    createdAt: 1,
    updatedAt: 2,
  }
  return {
    served: { current: memory },
    memoryNote: vi.fn(async (_id: string, noteId: string | null) => ({ memory: { ...memory, noteId } })),
    openNote: vi.fn(async () => undefined),
  }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: {},
    assistant: {
      memories: vi.fn(async () => ({
        memories: [served.current],
        total: 1,
        counts: { active: 1, historical: 0, review: 0 },
      })),
      memoryNote,
      reviews: vi.fn(async () => ({ reviews: [] })),
      projects: vi.fn(async () => ({ projects: [] })),
    },
  },
}))

/** A fact that knows the page it was written out as. */
function fromNote(noteId: string | null): AssistantMemory {
  return { ...served.current, noteId }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label)
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
let root: Root
let host: HTMLElement

async function show(memory: AssistantMemory): Promise<void> {
  served.current = memory
  useAssistant.setState({
    ...assistantOriginal,
    memories: [memory],
    memoryTotal: 1,
    memoryCounts: { active: 1, historical: 0, review: 0 },
    projects: [],
    reviews: [],
  })
  await act(async () => { root.render(createElement(MemoryView)) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  memoryNote.mockClear()
  openNote.mockClear()
  useNotes.setState({ hydrated: true, notes: {}, openNote })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('the memory row of a fact that names a page', () => {
  it('opens the note, and says which one it opens', async () => {
    useNotes.setState({
      hydrated: true,
      notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Hiring plan', deletedAt: null } as never },
    })
    await show(fromNote(NOTE_ID))
    const entry = button(`${t('assistant.memory.open_note')}: Hiring plan`)
    expect(entry, 'the row offers no entry that names its note').toBeTruthy()
    act(() => { entry!.click() })
    expect(openNote).toHaveBeenCalledWith(NOTE_ID)
    expect(window.location.pathname).toBe('/notes')
    expect(document.body.textContent).not.toContain(t('assistant.memory.note_gone'))
  })

  it('says the note is gone when the page it names is not there', async () => {
    useNotes.setState({ hydrated: true, notes: {} })
    await show(fromNote(NOTE_ID))
    expect(document.body.textContent).toContain(t('assistant.memory.note_gone'))
    expect(button(t('assistant.memory.open_note'))).toBeUndefined()
    const unlink = button(t('assistant.memory.forget_note_link'))
    expect(unlink, 'a dead pointer offers no way to take it off').toBeTruthy()
    await act(async () => { unlink!.click() })
    expect(memoryNote).toHaveBeenCalledWith('m1', null)
  })

  it('calls a note in the trash a gone note', async () => {
    useNotes.setState({
      hydrated: true,
      notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Hiring plan', deletedAt: 1_000 } as never },
    })
    await show(fromNote(NOTE_ID))
    expect(document.body.textContent).toContain(t('assistant.memory.note_gone'))
  })

  it('does not call a note gone before the list has been read', async () => {
    useNotes.setState({ hydrated: false, notes: {} })
    await show(fromNote(NOTE_ID))
    // An unread list says nothing about whether the page exists; claiming it is gone would be a invented
    // fact about the reader's vault, and the entry is still the one they can press.
    expect(document.body.textContent).not.toContain(t('assistant.memory.note_gone'))
    expect(button(t('assistant.memory.open_note'))).toBeTruthy()
  })

  it('leaves a fact that was never written out as a note alone', async () => {
    useNotes.setState({ hydrated: true, notes: {} })
    await show(fromNote(null))
    expect(document.body.textContent).not.toContain(t('assistant.memory.note_gone'))
    expect(button(t('assistant.memory.save_note'))).toBeTruthy()
  })
})
