import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultQuickAddSettings,
  newMacroChoice,
  newCaptureChoice,
  newGroupChoice,
  newTemplateChoice,
  type QuickAddChoice,
} from '@shared/quickadd'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useQuickAdd } from '../../store/quickadd'
import { useUi } from '../../store/ui'
import { CommandPalette } from './CommandPalette'

const runs = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../../lib/quickadd/runner', () => ({
  runQuickAddChoice: async (id: string) => {
    runs.calls.push(id)
    return { kind: 'written', noteId: 'n-target', created: false, summary: 'ran' }
  },
}))

const MORNING = { ...newTemplateChoice('qa-morning', 'Morning note', 0), asCommand: true }
const NOT_A_COMMAND = { ...newCaptureChoice('qa-inbox', 'Inbox capture', 1), asCommand: false }
const DISABLED: QuickAddChoice = { ...newMacroChoice('qa-off', 'Off command', 2), asCommand: true, enabled: false }
const GROUP: QuickAddChoice = { ...newGroupChoice('qa-group', 'Journal group', 3), asCommand: true }

let root: Root
let container: HTMLDivElement
const originalUi = useUi.getState()
const originalQuickAdd = useQuickAdd.getState()

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
}

function rowText(): string {
  return rows().map((row) => row.textContent ?? '').join('|')
}

async function open(query = '> '): Promise<void> {
  await act(async () => {
    root.render(createElement(CommandPalette, { onClose: () => {}, initialQuery: query }))
    await Promise.resolve()
  })
}

async function pick(label: string): Promise<void> {
  const row = rows().find((candidate) => (candidate.textContent ?? '').includes(label))
  if (!row) throw new Error(`no palette row containing "${label}"`)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function seed(choices: QuickAddChoice[], enabled = true): void {
  act(() => {
    useQuickAdd.setState({
      choices,
      settings: { ...defaultQuickAddSettings(), enabled },
      hydrated: true,
      owner: 'user-1',
    })
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  runs.calls = []
  vi.spyOn(api, 'search').mockResolvedValue({
    results: [],
    mode: 'fts',
    took: 0,
    query: { text: '', tags: [], excludedTags: [], folder: null, starred: null, archived: null },
  })
  useNotes.setState({ notes: {}, tags: [], folders: [], contents: {}, hydrated: true, loading: false })
  useUi.setState({ activeNoteId: null, selectedIds: [], recentNoteIds: [], panel: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => { await root.unmount() })
  container?.remove()
  useUi.setState(originalUi, true)
  useQuickAdd.setState(originalQuickAdd, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('QuickAdd in the command palette', () => {
  it('offers the launcher as a command of its own', async () => {
    seed([MORNING])
    await open()
    expect(rowText()).toContain(t('quickadd.launcher_title'))
    await pick(t('quickadd.launcher_title'))
    expect(useUi.getState().panel).toBe('quickadd')
  })

  it('lists a choice marked as a command under the QuickAdd group', async () => {
    seed([MORNING, NOT_A_COMMAND, DISABLED, GROUP])
    await open()
    const text = rowText()
    expect(text).toContain('Morning note')
    expect(text).toContain(t('quickadd.group'))
    // Not a command, switched off, or a group: none of those may be a runnable palette row.
    expect(text).not.toContain('Inbox capture')
    expect(text).not.toContain('Off command')
    expect(text).not.toContain('Journal group')
  })

  it('runs the choice the reader picked, not the launcher', async () => {
    seed([MORNING])
    await open()
    await pick('Morning note')
    expect(runs.calls).toEqual(['qa-morning'])
    expect(useUi.getState().panel).toBeNull()
  })

  it('vanishes from the palette when QuickAdd is switched off', async () => {
    seed([MORNING], false)
    await open()
    const text = rowText()
    expect(text).not.toContain('Morning note')
    expect(text).not.toContain(t('quickadd.launcher_title'))
  })

  it('follows a rename without a reload', async () => {
    seed([MORNING])
    await open()
    expect(rowText()).toContain('Morning note')
    seed([{ ...MORNING, name: 'Dawn page' }])
    await act(async () => {
      await Promise.resolve()
    })
    expect(rowText()).toContain('Dawn page')
    expect(rowText()).not.toContain('Morning note')
  })

  it('is findable by what the reader types, not only in command mode', async () => {
    // A Chinese choice name is the case the fuzzy + pinyin path has to answer to; `check-i18n.mjs`
    // keeps such data out of `src/` because interface copy belongs in the catalog.
    const CJK_CHOICE_FIXTURES = { name: '周记收集', query: '周记' }
    seed([{ ...MORNING, name: CJK_CHOICE_FIXTURES.name }])
    await open(CJK_CHOICE_FIXTURES.query)
    expect(rowText()).toContain(CJK_CHOICE_FIXTURES.name)
  })
})
