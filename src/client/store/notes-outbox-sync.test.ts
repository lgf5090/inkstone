/**
 * The note half of the shared outbox, after the queue stopped being notes-only.
 *
 * A queue written by an older build has `noteId` and no `entity`. Those rows are note writes — the
 * only kind that existed — and must still replay through `api.notes.patch`: a migration that reads
 * them as anything else would strand offline edits in IndexedDB forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '@shared/types'

const mocks = vi.hoisted(() => ({
  queue: [] as unknown[],
  patch: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  linkMention: vi.fn(),
}))

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>()
  const normalize = actual.normalizeOutboxItem
  return {
    ...actual,
    publishBroadcast: vi.fn(),
    localDb: {
      scheduleShellSave: vi.fn(),
      setContent: vi.fn(async () => {}),
      setContentBatch: vi.fn(async () => {}),
      dropContent: vi.fn(async () => {}),
      getOutbox: async () => mocks.queue.map(normalize).filter((item) => item !== null),
      enqueueOutbox: async (item: unknown) => {
        mocks.queue = [...mocks.queue.filter((entry) => (entry as { id?: string }).id !== (item as { id: string }).id), item]
      },
      enqueueOutboxBatch: async (items: unknown[]) => {
        for (const item of items)
          mocks.queue = [...mocks.queue.filter((entry) => (entry as { id?: string }).id !== (item as { id: string }).id), item]
      },
      completeOutboxItem: async (id: string, writeId: string) => {
        mocks.queue = mocks.queue.filter((entry) => {
          const item = normalize(entry)
          return !item || item.id !== id || item.writeId !== writeId
        })
      },
      updateOutboxRevision: vi.fn(async () => {}),
      setOutboxRecoveryId: vi.fn(async () => {}),
      advanceOutboxDependents: vi.fn(async () => {}),
      markOutboxFailure: vi.fn(async () => {}),
      withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => {
        await task()
        return true
      },
    },
  }
})

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<{ api: Record<string, unknown> }>('../lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      notes: { get: mocks.get, patch: mocks.patch, create: mocks.create, linkMention: mocks.linkMention },
      sync: vi.fn(),
    },
  }
})

import { CLIENT_ID } from '../lib/api'
import { useNotes } from './notes'

const note: Note = {
  id: '01legacynote',
  title: 'Legacy',
  excerpt: 'before',
  content: 'before',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 1,
  charCount: 6,
  rev: 1,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

beforeEach(() => {
  mocks.patch.mockReset()
  mocks.get.mockReset()
  mocks.create.mockReset()
  mocks.linkMention.mockReset()
  mocks.queue = [{
    id: `patch:${CLIENT_ID}:${note.id}`,
    clientId: CLIENT_ID,
    writeId: 'write-from-an-older-build',
    // Deliberately the pre-`entity` shape: no `entity`, no `entityId`.
    noteId: note.id,
    payload: { content: 'offline edit', contentDirty: true, rev: 1 },
    attempts: 0,
    createdAt: 1,
  }]
  mocks.patch.mockResolvedValue({ ...note, rev: 2, content: 'offline edit', updatedAt: 2 })
  useNotes.setState({
    notes: { [note.id]: note },
    contents: { [note.id]: note.content },
    folders: [],
    tags: [],
    cursor: 1,
    pendingCount: 1,
    online: false,
  })
})

describe('a queue row written before the outbox carried an entity', () => {
  it('is replayed as a note write and leaves the queue', async () => {
    await useNotes.getState().replayPending()

    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith(note.id, expect.objectContaining({ rev: 1, content: 'offline edit' }))
    expect(mocks.queue).toHaveLength(0)
    expect(useNotes.getState().contents[note.id]).toBe('offline edit')
    expect(useNotes.getState().notes[note.id]!.rev).toBe(2)
  })
})
