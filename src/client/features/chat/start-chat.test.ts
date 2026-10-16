// @vitest-environment jsdom
/**
 * Starting a thread that is about one note, or one folder.
 *
 * The command is small and its contract is what matters: a *new* thread (a chip describes what one thread
 * was asked about, so it must not follow the reader into another), the scope already pinned, and the
 * assistant in front of them — the dock in the notebook, the chat tab everywhere else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n } from '../../lib/i18n'
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
