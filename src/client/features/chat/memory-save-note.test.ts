// @vitest-environment jsdom
/**
 * A memory written out as a note.
 *
 * Two halves have to hold for this to be worth anything: the note really is created with the fact as its
 * body, and the memory remembers which note it became — otherwise the reader saves the same fact twice and
 * the button never becomes "open the note".
 *
 * The memory's own text is copied, not summarised: what was remembered is what the note says, and the two
 * then live apart, which is what the dialog tells the reader before they press the button.
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

const { createNote, memoryNote, openNote, MEMORY, served } = vi.hoisted(() => {
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
    updatedAt: 1,
  }
  return {
    MEMORY: memory,
    // What the page's own mount-time read answers. A test swaps this before rendering, because the page
    // reads its list itself and would otherwise overwrite whatever the store was seeded with.
    served: { current: memory },
    createNote: vi.fn(async (body: Record<string, unknown>) => ({ id: '01hzzzzzzzzzzzzzzzzzzzzz55', title: body.title })),
    memoryNote: vi.fn(async (_id: string, noteId: string | null) => ({ memory: { ...memory, noteId } })),
    openNote: vi.fn(async () => undefined),
  }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: { create: createNote },
    assistant: {
      // The page reads its own list on mount, so the fixture has to come back from that read rather than
      // only from the store this file seeds.
      memories: vi.fn(async () => ({ memories: [served.current], total: 1, counts: { active: 1, historical: 0, review: 0 } })),
      memoryNote,
      reviews: vi.fn(async () => ({ reviews: [] })),
      projects: vi.fn(async () => ({ projects: [] })),
    },
  },
}))

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

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label)
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  vi.clearAllMocks()
})

describe('saving a memory as a note', () => {
  it('creates the note from the memory, then records which note it became', async () => {
    useNotes.setState({ openNote })
    await show(MEMORY)
    const save = button(t('assistant.memory.save_note'))
    expect(save, 'the save control is missing').toBeTruthy()
    act(() => { save!.click() })
    // The dialog arrives with the fact as the title, which is what the reader would have typed.
    const title = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(title.value).toBe(MEMORY.content)
    const confirmButton = [...document.body.querySelectorAll('button')]
      .find((node) => node.textContent === t('assistant.memory.save_note') && node !== save)
    expect(confirmButton, 'the dialog has no confirm button').toBeTruthy()
    await act(async () => { confirmButton!.click() })
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ content: MEMORY.content, folderId: null }))
    expect(memoryNote).toHaveBeenCalledWith('m1', '01hzzzzzzzzzzzzzzzzzzzzz55')
    expect(useAssistant.getState().memories[0]!.noteId).toBe('01hzzzzzzzzzzzzzzzzzzzzz55')
    expect(openNote).toHaveBeenCalledWith('01hzzzzzzzzzzzzzzzzzzzzz55')
  })

  it('offers to open the note once there is one, instead of saving it again', async () => {
    await show({ ...MEMORY, noteId: '01hzzzzzzzzzzzzzzzzzzzzz55' })
    expect(button(t('assistant.memory.save_note'))).toBeUndefined()
    expect(button(t('assistant.memory.open_note'))).toBeTruthy()
  })
})
