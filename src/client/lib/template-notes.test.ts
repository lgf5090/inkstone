import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { Folder, NoteTemplate } from '@shared/types'
import { initI18n } from './i18n'
import { setInboxFolderId } from './folder-prefs'
import { useSession } from '../store/session'
import { useUi } from '../store/ui'
import { useNotes } from '../store/notes'
import { takePendingEditorCursor } from '../store/new-note'
import { createNoteFromTemplate } from './template-notes'

const create = vi.hoisted(() => vi.fn())

vi.mock('../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    setContent: vi.fn(async () => {}),
    setContentBatch: vi.fn(async () => {}),
    dropContent: vi.fn(async () => {}),
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => { await task(); return true },
  },
  publishBroadcast: vi.fn(),
}))

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, api: { ...actual.api, notes: { ...actual.api.notes, create } } }
})

const JOURNAL: Folder = {
  id: 'f-journal', name: 'Journal', parentId: null, icon: null, color: null,
  position: 0, createdAt: 1, updatedAt: 1,
}
const IDEAS: Folder = {
  id: 'f-ideas', name: 'Ideas', parentId: null, icon: null, color: null,
  position: 1, createdAt: 1, updatedAt: 1,
}

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    categoryId: null,
    name: 'Weekly review',
    description: '',
    content: '---\ntitle: {{title}}\n---\n\n# {{title}}\n\n{{cursor}}\n',
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function payload(): Record<string, unknown> {
  return create.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(async () => {
  localStorage.clear()
  create.mockReset()
  create.mockImplementation(async (body: Record<string, unknown>) => {
    const now = Date.now()
    return {
      id: (body?.id as string | undefined) ?? 'n-1', title: String(body?.title ?? ''), content: String(body?.content ?? ''), excerpt: '',
      folderId: (body?.folderId as string | null | undefined) ?? null, tags: [], isPinned: false, isStarred: Boolean(body?.isStarred),
      isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: now,
      createdAt: now, updatedAt: now, deletedAt: null,
    }
  })
  await initI18n()
  useSession.setState({ settings: { ...DEFAULT_SETTINGS }, status: 'authed', user: null })
  useNotes.setState({ folders: [JOURNAL, IDEAS], notes: {}, tags: [] } as never)
  useUi.setState({ view: 'all', folderId: null, tags: [], tag: null } as never)
})

describe('creating a note from a template', () => {
  it('lands in the folder whose view is open, the way the + button does', async () => {
    useUi.setState({ view: 'folder', folderId: JOURNAL.id } as never)
    await createNoteFromTemplate(template())
    expect(payload().folderId).toBe(JOURNAL.id)
  })

  it('is starred when the note was started from the starred view', async () => {
    useUi.setState({ view: 'starred' } as never)
    await createNoteFromTemplate(template())
    expect(payload().isStarred).toBe(true)
  })

  it('goes to the inbox when the view carries no folder of its own', async () => {
    setInboxFolderId(IDEAS.id)
    await createNoteFromTemplate(template())
    expect(payload().folderId).toBe(IDEAS.id)
  })

  it('honours an explicit folder over the view, which is how the sidebar asks', async () => {
    useUi.setState({ view: 'folder', folderId: JOURNAL.id } as never)
    await createNoteFromTemplate(template(), { folderId: IDEAS.id })
    expect(payload().folderId).toBe(IDEAS.id)
  })

  it('keeps the caret where the template pointed it', async () => {
    create.mockImplementation(async (body: Record<string, unknown>) => {
      const now = Date.now()
      return {
        id: 'n-cursor', title: String(body?.title ?? ''), content: String(body?.content ?? ''), excerpt: '',
        folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false,
        wordCount: 0, charCount: 0, rev: 1, position: now, createdAt: now, updatedAt: now, deletedAt: null,
      }
    })
    await createNoteFromTemplate(template())
    const body = payload()
    expect(String(body.content)).not.toContain('{{cursor}}')
    const pending = takePendingEditorCursor(String(body.id))
    expect(typeof pending, `no caret was remembered for ${String(body.id)}`).toBe('number')
    expect(pending).toBeGreaterThan(0)
  })
})
