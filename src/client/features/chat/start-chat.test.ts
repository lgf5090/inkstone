// @vitest-environment jsdom
/**
 * Starting a thread that is about one note, or one folder.
 *
 * The command is small and its contract is what matters: a *new* thread (a chip describes what one thread
 * was asked about, so it must not follow the reader into another), the scope already pinned, and the
 * assistant in front of them — the dock in the notebook, the chat tab everywhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { startChatAboutFolder, startChatAboutNote } from './start-chat'

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  await initI18n()
  useNotes.setState({
    notes: { n1: { id: 'n1', title: 'A plan' } as never, n2: { id: 'n2', title: 'Gone', deletedAt: 1 } as never },
    folders: [{ id: 'f1', name: 'Work' } as never],
  })
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
})

describe('chatting about a note', () => {
  it('starts a fresh thread with the note pinned, and opens the dock in the notebook', () => {
    navigateToPath('/notes')
    useAssistant.setState({ activeId: 'c-old', turnScopes: [{ kind: 'tag', id: 't1', name: 'old' }] })
    startChatAboutNote('n1')
    expect(useAssistant.getState().activeId).toBeNull()
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'note', id: 'n1', name: 'A plan' }])
    expect(useUi.getState().assistantDockOpen).toBe(true)
  })

  it('goes to the chat tab when the notebook is not on screen', () => {
    navigateToPath('/chat')
    startChatAboutNote('n1')
    expect(window.location.pathname).toBe('/chat')
    expect(useUi.getState().assistantDockOpen).toBe(false)
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'note', id: 'n1', name: 'A plan' }])
  })

  it('does nothing for a note that is gone', () => {
    startChatAboutNote('n2')
    expect(useAssistant.getState().turnScopes).toEqual([])
  })
})

describe('chatting about a folder', () => {
  it('pins the folder as the scope', () => {
    navigateToPath('/notes')
    startChatAboutFolder('f1')
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'folder', id: 'f1', name: 'Work' }])
    expect(useUi.getState().assistantDockOpen).toBe(true)
  })
})

/**
 * The same command asked while an answer is on its way.
 *
 * A new conversation is refused then, so without a guard of its own this command half-applies: the thread
 * stays the live one and the chip lands on it, which re-scopes a conversation the reader was mid-way
 * through and looks, to them, like a menu entry that does nothing. Both entry points are reached from the
 * list and the tree directly, so the refusal has to live here rather than in the one caller that already
 * checks.
 */
describe('chatting about a note or folder while a turn is streaming', () => {
  /** A turn that has not ended: the state a second conversation is refused for. */
  const LIVE = {
    conversationId: 'c-old',
    userText: 'a question',
    attachments: [],
    assistantId: null,
    text: 'half an answer',
    reasoning: '',
    tools: [],
    stage: 'writing',
    error: null,
    done: false,
  } as never

  beforeEach(() => {
    navigateToPath('/notes')
    useAssistant.setState({ activeId: 'c-old', turn: LIVE, turnScopes: [{ kind: 'tag', id: 't1', name: 'old' }] })
  })

  it('refuses to move a note chip onto the thread the reader is watching', () => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startChatAboutNote('n1')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.busy'), tone: 'warning' }))
    expect(useAssistant.getState().activeId).toBe('c-old')
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'tag', id: 't1', name: 'old' }])
  })

  it('refuses for a folder too, and does not surface a thread it did not start', () => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startChatAboutFolder('f1')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.busy'), tone: 'warning' }))
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'tag', id: 't1', name: 'old' }])
    expect(useUi.getState().assistantDockOpen).toBe(false)
  })
})
