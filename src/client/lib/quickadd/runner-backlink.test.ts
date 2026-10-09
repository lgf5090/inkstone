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
})

afterEach(() => {
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

  it('refuses the line placement when the note is not the one on screen', async () => {
    seed('started here\n')
    useUi.setState({ activeNoteId: 'n-Beta' } as never)
    expect(await notePort.appendLink(source, target, { placement: 'lineEnd' })).toBe(false)
    expect(useNotes.getState().contents['n-Source']).toBe('started here\n')
  })

  it('refuses a property block the YAML cannot read', async () => {
    seed('---\nmood: [unclosed\n---\nbody\n')
    expect(await notePort.appendLink(source, target, { placement: 'property', property: 'origin' })).toBe(false)
  })
})
