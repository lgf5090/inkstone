import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { CommandPalette } from './CommandPalette'

const LINTER_COMMANDS = [
  'linter.command.lint_note',
  'linter.command.preview_note',
  'linter.command.paste_plain',
  'linter.command.lint_folder',
  'linter.command.lint_all',
  'linter.command.ignore_note',
  'linter.command.ignore_folder',
] as const

const NOTE: NoteSummary = {
  id: 'n1',
  title: 'Working note',
  excerpt: '',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 0,
  charCount: 0,
  rev: 1,
  position: 0,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2),
  deletedAt: null,
}

let root: Root
let container: HTMLDivElement
const originalUi = useUi.getState()
const originalNotes = useNotes.getState()
const originalSession = useSession.getState()

function rows(): string {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
    .map((row) => row.textContent ?? '')
    .join('|')
}

function setLinter(patch: Record<string, unknown>): void {
  act(() => {
    useSession.setState({
      settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, ...patch } }),
    })
  })
}

async function open(query = '> '): Promise<void> {
  await act(async () => {
    root.render(createElement(CommandPalette, { onClose: () => {}, initialQuery: query }))
    await Promise.resolve()
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  vi.spyOn(api, 'search').mockResolvedValue({
    results: [],
    mode: 'fts',
    took: 0,
    query: { text: '', tags: [], excludedTags: [], folder: null, starred: null, archived: null },
  })
  useNotes.setState({ notes: { n1: NOTE }, tags: [], folders: [], contents: {}, hydrated: true, loading: false })
  useUi.setState({ activeNoteId: 'n1', selectedIds: [], recentNoteIds: [], panel: null })
  useSession.setState({ updateSettings: () => Promise.resolve() })
  setLinter({})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => { await root.unmount() })
  container?.remove()
  useUi.setState(originalUi, true)
  useNotes.setState(originalNotes, true)
  useSession.setState(originalSession, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the linter in the command palette', () => {
  it('offers every formatting command while the linter is on', async () => {
    await open()
    const text = rows()
    for (const key of LINTER_COMMANDS) {
      expect(text).toContain(t(key))
    }
  })

  it('takes the whole family away when the reader switches the linter off', async () => {
    setLinter({ enabled: false })
    await open()
    const text = rows()
    for (const key of LINTER_COMMANDS) {
      expect(text).not.toContain(t(key))
    }
  })

  it('follows the switch without a reload', async () => {
    await open()
    expect(rows()).toContain(t('linter.command.lint_note'))
    setLinter({ enabled: false })
    await act(async () => {
      await Promise.resolve()
    })
    expect(rows()).not.toContain(t('linter.command.lint_note'))
  })
})
