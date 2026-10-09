/**
 * The app-backed half of writing a link back into the note a run started from: the end of its body, the
 * end of the line the caret was on, or a property of it. The engines only ask for a place; which of these
 * the app can actually honour is decided here, against a real note store.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFrontMatter } from '@shared/markdown-utils'
import type { NoteSummary } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'

const saved = vi.hoisted(() => ({ current: '' }))

// The notes store writes through idb-keyval, which jsdom does not provide, so the local mirror is an
// in-memory map here. What the run wrote is asserted through the store, which is what the reader sees.
const shelves = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    saveShell: vi.fn(async () => {}),
    loadShell: async () => null,
    bindUser: async () => {},
    setContent: async (id: string, content: string) => { shelves.set(id, content) },
    setContentBatch: async (entries: Record<string, string>) => {
      for (const [id, content] of Object.entries(entries)) shelves.set(id, content)
    },
    getContent: async (id: string) => shelves.get(id),
    dropContent: async (id: string) => { shelves.delete(id) },
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    enqueueOutboxBatch: async () => {},
    completeOutboxItem: async () => {},
    markOutboxFailure: async () => {},
    updateOutboxRevision: async () => {},
    advanceOutboxDependents: async () => {},
    setOutboxRecoveryId: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => {
      await task()
      return true
    },
  },
  publishBroadcast: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      notes: {
        ...actual.api.notes,
        get: vi.fn(async (id: string) => ({ id, title: id === 'n-Source' ? 'Source' : 'Beta', content: saved.current, rev: 3 })),
        patch: vi.fn(async () => undefined),
      },
    },
  }
})

import { notePort } from './runner'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

// The port reads the caret line off whatever CodeMirror view the app holds. jsdom has no editor of its
// own, so the test hands it one — and the rest of the module stays loaded, which other QuickAdd seams need.
const editorView = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../editor/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../editor/commands')>()
  return { ...actual, getActiveEditorView: () => editorView.current ?? null }
})

/**
 * A CodeMirror view as small as the two lines the port reads from it. The caret line placement is the
 * one that must not touch a note other than the source, and jsdom has no editor of its own to ask.
 */
function fakeView(text: string, caret: number) {
  const dispatches: { changes: { from: number; insert: string } }[] = []
  const lines = text.split('\n')
  let offset = 0
  const rows = lines.map((line) => {
    const from = offset
    offset += line.length + 1
    return { from, to: from + line.length, text: line }
  })
  const view = {
    dom: { isConnected: true, closest: () => null },
    state: {
      doc: {
        toString: () => text,
        lineAt: (at: number) => rows.find((row) => at >= row.from && at <= row.to) ?? rows[rows.length - 1],
      },
      selection: { main: { head: caret, from: caret, to: caret } },
    },
    dispatch: (transaction: { changes: { from: number; insert: string } }) => { dispatches.push(transaction) },
    focus: () => {},
  }
  return { view, dispatches, endOfFirstLine: rows[0].to }
}

function summary(id: string, title: string): NoteSummary {
  return {
    id, title, excerpt: title, folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 1, charCount: 4, rev: 1, position: 0, createdAt: 1, updatedAt: 1,
    deletedAt: null,
  }
}

const SOURCE = summary('n-Source', 'Source')
const TARGET = summary('n-Beta', 'Beta')

beforeAll(async () => {
  await initI18n()
})

let notesWere: unknown
let uiWere: unknown

/** The source note, open in the store so a write lands on its cached copy. */
function seed(body: string) {
  saved.current = body
  useNotes.setState({
    notes: { 'n-Source': SOURCE, 'n-Beta': TARGET },
    contents: { 'n-Source': body, 'n-Beta': 'the note that was made\n' },
    folders: [],
    tags: [],
    hydrated: true,
  } as never)
  useUi.setState({
    view: 'note',
    activeNoteId: 'n-Source',
    workspacePrimaryNoteId: 'n-Source',
    workspaceSecondaryNoteId: null,
    activeWorkspacePane: 'primary',
    workspacePaneLayouts: { primary: 'live', secondary: 'live' },
    mobilePane: 'edit',
  } as never)
}

const source = { id: 'n-Source', title: 'Source', folderPath: null }
const target = { id: 'n-Beta', title: 'Beta', folderPath: null }

beforeEach(() => {
  notesWere = useNotes.getState()
  uiWere = useUi.getState()
  editorView.current = null
})

afterEach(() => {
  editorView.current = null
  useNotes.setState(notesWere as never)
  useUi.setState(uiWere as never)
})

describe('the link a run writes back into the note it started from', () => {
  it('adds the labelled line at the end of the body', async () => {
    seed('started here\n')
    expect(await notePort.appendLink(source, target, { placement: 'noteEnd', property: 'source', embed: false })).toBe(true)
    expect(useNotes.getState().contents['n-Source']).toContain(t('quickadd.link_line', { link: '[[Beta]]' }))
  })

  it('writes a transclusion when the choice asked for one', async () => {
    seed('started here\n')
    await notePort.appendLink(source, target, { placement: 'noteEnd', embed: true })
    expect(useNotes.getState().contents['n-Source']).toContain('![[Beta]]')
  })

  it('creates the property the choice names', async () => {
    seed('---\nmood: glad\n---\nstarted here\n')
    expect(await notePort.appendLink(source, target, { placement: 'property', property: 'origin' })).toBe(true)
    const written = useNotes.getState().contents['n-Source'] ?? ''
    expect(parseFrontMatter(written).data.origin).toEqual(['[[Beta]]'])
    expect(written).toContain('mood: glad')
    expect(written).toContain('started here')
  })

  it('grows an existing scalar into a list instead of replacing it', async () => {
    seed("---\norigin: '[[Earlier]]'\n---\nbody\n")
    await notePort.appendLink(source, target, { placement: 'property', property: 'origin' })
    expect(parseFrontMatter(useNotes.getState().contents['n-Source'] ?? '').data.origin).toEqual(['[[Earlier]]', '[[Beta]]'])
  })

  it('takes the key the note already spells, whatever its case', async () => {
    seed("---\nSource: '[[Earlier]]'\n---\nbody\n")
    await notePort.appendLink(source, target, { placement: 'property', property: 'source' })
    const written = useNotes.getState().contents['n-Source'] ?? ''
    expect(parseFrontMatter(written).data.Source).toEqual(['[[Earlier]]', '[[Beta]]'])
    expect(Object.keys(parseFrontMatter(written).data)).toEqual(['Source'])
  })

  it('leaves a note that is already linked alone', async () => {
    seed("---\norigin: ['[[Beta]]']\n---\nbody\n")
    const before = useNotes.getState().contents['n-Source']
    expect(await notePort.appendLink(source, target, { placement: 'property', property: 'origin' })).toBe(true)
    expect(useNotes.getState().contents['n-Source']).toBe(before)
  })

  it('writes the link onto the end of the caret’s own line in the source note', async () => {
    seed('started here\nsecond line\n')
    const { view, dispatches, endOfFirstLine } = fakeView('started here\nsecond line\n', 4)
    editorView.current = view
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(true)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].changes.from, 'the link lands at the end of the line the caret sat on').toBe(endOfFirstLine)
    expect(dispatches[0].changes.insert).toBe(' [[Beta]]')
  })

  it('moves a caret parked in the properties block below it', async () => {
    seed('---\nmood: glad\n---\nfirst body\n')
    const { view, dispatches } = fakeView('---\nmood: glad\n---\nfirst body\n', 4)
    editorView.current = view
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(true)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].changes.from, 'the link joins the first line of the body, not the dashes').toBe(29)
    expect(dispatches[0].changes.insert).toBe(' [[Beta]]')
  })

  it('still honours a caret on a later line of a note that has properties', async () => {
    seed('---\nmood: glad\n---\nfirst body\nsecond line\n')
    const { view, dispatches } = fakeView('---\nmood: glad\n---\nfirst body\nsecond line\n', 32)
    editorView.current = view
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(true)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].changes.from, 'past the block the guard looks, but still the caret’s own line').toBe(41)
  })

  it('refuses the line placement when a different note is on screen', async () => {
    seed('started here\n')
    const { view, dispatches } = fakeView('someone else\nand their note\n', 3)
    editorView.current = view
    useUi.setState({ activeNoteId: 'n-Beta' } as never)
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(false)
    expect(dispatches, 'the other note on screen keeps its text').toHaveLength(0)
    expect(useNotes.getState().contents['n-Source']).toBe('started here\n')
  })

  it('refuses the line placement when no editor is open at all', async () => {
    seed('started here\n')
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(false)
    expect(useNotes.getState().contents['n-Source']).toBe('started here\n')
  })

  it('refuses a property block the YAML cannot read', async () => {
    seed('---\nmood: [unclosed\n---\nbody\n')
    expect(await notePort.appendLink(source, target, { placement: 'property', property: 'origin' })).toBe(false)
  })
})
