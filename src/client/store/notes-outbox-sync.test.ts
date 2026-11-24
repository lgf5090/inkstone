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
  replayProject: vi.fn(),
  completeBatch: vi.fn(),
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
      completeOutboxBatch: mocks.completeBatch,
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

vi.mock('../features/project/offline-outbox', () => ({
  replayProjectOutboxItem: mocks.replayProject,
  notifyProjectOutboxFlushed: vi.fn(),
}))

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

import { ApiError, CLIENT_ID } from '../lib/api'
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
  mocks.replayProject.mockReset()
  mocks.completeBatch.mockReset().mockImplementation(async (items: Array<{ id: string; writeId: string }>) => {
    const completed = new Set(items.map((item) => JSON.stringify([item.id, item.writeId])))
    mocks.queue = mocks.queue.filter((entry) => {
      const item = entry as { id?: string; writeId?: string }
      return !completed.has(JSON.stringify([item.id, item.writeId]))
    })
  })
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

describe('a queued project write', () => {
  it('is handed to the project module and removed from the shared queue', async () => {
    mocks.queue = [{
      id: 'pw_1', clientId: CLIENT_ID, writeId: 'pw_1', entity: 'project', entityId: 'b1',
      payload: { path: '/api/project/cards/c1', method: 'PATCH', body: {} },
      attempts: 0, createdAt: 1,
    }]
    mocks.replayProject.mockResolvedValue({ status: 'done' })
    await useNotes.getState().replayPending()
    expect(mocks.replayProject).toHaveBeenCalledTimes(1)
    expect(mocks.replayProject.mock.calls[0]![0]).toMatchObject({ entity: 'project', writeId: 'pw_1' })
    expect(mocks.queue).toHaveLength(0)
    expect(mocks.patch).not.toHaveBeenCalled()
  })
})

function queuedNote(id: string, writeId: string, createdAt: number, rev: number, dependsOnWriteId?: string) {
  return {
    id: `patch:${CLIENT_ID}:${id}`,
    clientId: CLIENT_ID,
    writeId,
    ...(dependsOnWriteId ? { dependsOnWriteId } : {}),
    entity: 'note',
    entityId: id,
    payload: { content: `content:${writeId}`, contentDirty: true, rev },
    attempts: 0,
    createdAt,
  }
}

describe('independent-note replay waves', () => {
  it('commits independent notes together without moving a dependent write ahead of its base', async () => {
    const ids = ['note-a', 'note-b']
    mocks.queue = [
      queuedNote('note-a', 'a-1', 1, 1),
      queuedNote('note-b', 'b-1', 2, 1),
      queuedNote('note-a', 'a-2', 3, 2, 'a-1'),
    ]
    useNotes.setState({
      notes: Object.fromEntries(ids.map((id) => [id, { ...note, id }])),
      contents: Object.fromEntries(ids.map((id) => [id, 'before'])),
      online: true,
    })
    mocks.patch.mockImplementation(async (id: string, patch: { rev: number; content: string }) => ({
      ...note, id, rev: patch.rev + 1, content: patch.content, updatedAt: patch.rev + 1,
    }))

    await useNotes.getState().replayPending()

    expect(mocks.patch.mock.calls.map(([id, patch]) => [id, patch.rev])).toEqual([
      ['note-a', 1],
      ['note-b', 1],
      ['note-a', 2],
    ])
    expect(mocks.completeBatch.mock.calls.map(([items]) => items.map((entry: { writeId: string }) => entry.writeId)))
      .toEqual([['a-1', 'b-1', 'a-2']])
    expect(mocks.queue).toEqual([])
  })

  it('can replay after a crash between server acceptance and the batch queue commit', async () => {
    const ids = ['note-a', 'note-b']
    const remote = new Map(ids.map((id) => [id, { ...note, id }]))
    mocks.queue = [queuedNote('note-a', 'a-1', 1, 1), queuedNote('note-b', 'b-1', 2, 1)]
    useNotes.setState({
      notes: Object.fromEntries(ids.map((id) => [id, remote.get(id)!])),
      contents: Object.fromEntries(ids.map((id) => [id, 'before'])),
      online: true,
    })
    mocks.patch.mockImplementation(async (id: string, patch: { rev: number; content: string }) => {
      const current = remote.get(id)!
      if (current.content === patch.content) {
        throw new ApiError(409, 'conflict', 'already saved', { server: current })
      }
      const saved = { ...current, rev: patch.rev + 1, content: patch.content, updatedAt: patch.rev + 1 }
      remote.set(id, saved)
      return saved
    })
    mocks.completeBatch.mockRejectedValueOnce(new Error('simulated crash before queue commit'))

    await useNotes.getState().replayPending()
    expect(mocks.queue).toHaveLength(2)

    await useNotes.getState().replayPending()
    expect(mocks.queue).toEqual([])
    expect(mocks.patch).toHaveBeenCalledTimes(4)
    expect(remote.get('note-a')!.content).toBe('content:a-1')
    expect(remote.get('note-b')!.content).toBe('content:b-1')
    expect(useNotes.getState().pendingCount).toBe(0)
  })
})
