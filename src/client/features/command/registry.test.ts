import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { openEmojiPicker } from '../../store/emoji-picker'
import { appCommands, findAppCommand, runAppCommand } from './registry'

vi.mock('../../store/emoji-picker', () => ({ openEmojiPicker: vi.fn() }))

const note: NoteSummary = {
  id: 'note-1', title: 'Alpha', excerpt: 'Text', folderId: null, tags: [],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 1, charCount: 4,
  rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}
const originalNotes = useNotes.getState()
const originalUi = useUi.getState()
const originalSession = useSession.getState()

const LINTER_COMMAND_IDS = [
  'cmd-lint-all',
  'cmd-lint-note',
  'cmd-lint-preview',
  'cmd-lint-paste-plain',
  'cmd-lint-folder',
  'cmd-lint-ignore-note',
  'cmd-lint-ignore-folder',
]

function openTheNote(): void {
  useNotes.setState({ notes: { [note.id]: note }, folders: [], tags: [], hydrated: true, loading: false })
  useUi.setState({ activeNoteId: note.id })
}

function setLinter(enabled: boolean): void {
  useSession.setState({ settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, enabled } }) })
}

beforeEach(async () => {
  await initI18n()
  vi.mocked(openEmojiPicker).mockClear()
  openTheNote()
  setLinter(true)
})

afterEach(() => {
  useNotes.setState(originalNotes)
  useUi.setState(originalUi)
  useSession.setState(originalSession)
})

function renderable(value: unknown): boolean {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && '$$typeof' in value)
}

describe('the command registry', () => {
  it('lists every command with the pieces the palette renders', () => {
    const commands = appCommands()
    expect(commands.length, 'the palette used to own this list; nothing may be dropped on the way out').toBe(50)
    expect(new Set(commands.map((entry) => entry.id)).size).toBe(commands.length)
    for (const entry of commands) {
      expect(entry.kind).toBe('command')
      expect(entry.label.trim()).not.toBe('')
      expect(entry.group.trim()).not.toBe('')
      expect(typeof entry.run).toBe('function')
      // Lucide components are forwardRef objects, so a plain `typeof === 'function'` check is wrong.
      expect(renderable(entry.icon), `the icon of ${entry.id}`).toBe(true)
    }
  })

  it('keeps the note-bound commands out of the list until a note is open', () => {
    expect(findAppCommand('cmd-star')).not.toBeNull()
    useUi.setState({ activeNoteId: null })
    const withoutNote = new Set(appCommands().map((entry) => entry.id))
    expect(withoutNote.has('cmd-new'), 'an app-wide command never needs a note').toBe(true)
    expect(withoutNote.has('cmd-star'), 'starring the current note needs a current note').toBe(false)
  })

  it('takes the linter family away with its own switch, not the note', () => {
    for (const id of LINTER_COMMAND_IDS) expect(findAppCommand(id), id).not.toBeNull()
    setLinter(false)
    const ids = new Set(appCommands().map((entry) => entry.id))
    for (const id of LINTER_COMMAND_IDS) {
      expect(ids.has(id), `the palette already hides ${id}, so a macro must not run it either`).toBe(false)
    }
    expect(ids.has('cmd-star'), 'the rest of the list is untouched').toBe(true)
    expect(runAppCommand('cmd-lint-note')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('runs a command by id without the palette being open', () => {
    const result = runAppCommand('cmd-emoji')
    expect(result).toEqual({ ok: true })
    expect(openEmojiPicker).toHaveBeenCalledTimes(1)
  })

  it('refuses an id it does not know instead of doing nothing quietly', () => {
    expect(runAppCommand('cmd-nope')).toEqual({ ok: false, reason: 'unavailable' })
    expect(runAppCommand('   ')).toEqual({ ok: false, reason: 'unavailable' })
    expect(openEmojiPicker).not.toHaveBeenCalled()
  })

  it('refuses a command whose note has gone away', () => {
    useUi.setState({ activeNoteId: null })
    expect(runAppCommand('cmd-delete'), 'the id is known but not offered right now').toEqual({ ok: false, reason: 'unavailable' })
  })
})
