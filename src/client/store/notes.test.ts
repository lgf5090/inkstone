import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Note, SyncResponse } from '@shared/types'

const mocks = vi.hoisted(() => ({ queue: [] as any[], get: vi.fn(), patch: vi.fn(), create: vi.fn() }))
vi.mock('../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(), setContent: vi.fn(async () => {}), setContentBatch: vi.fn(async () => {}),
    dropContent: vi.fn(async () => {}),
    getOutbox: async () => mocks.queue,
    enqueueOutbox: async (item: any) => { mocks.queue = [...mocks.queue.filter((q) => q.id !== item.id), item] },
    enqueueOutboxBatch: async (items: any[]) => {
      for (const item of items) mocks.queue = [...mocks.queue.filter((q) => q.id !== item.id), item]
    },
    completeOutboxItem: async (id: string, writeId: string) => {
      mocks.queue = mocks.queue.filter((q) => q.id !== id || q.writeId !== writeId)
    },
    setOutboxRecoveryId: async (id: string, writeId: string, recoveryId: string) => {
      mocks.queue = mocks.queue.map((q) => q.id === id && q.writeId === writeId
        ? { ...q, payload: { ...q.payload, recoveryId } } : q)
    },
    advanceOutboxDependents: vi.fn(async () => {}), markOutboxFailure: vi.fn(async () => {}),
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => { await task(); return true },
  }, publishBroadcast: vi.fn(),
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<any>('../lib/api')
  return { ...actual, api: { ...actual.api, notes: { get: mocks.get, patch: mocks.patch, create: mocks.create } } }
})
import { useNotes } from './notes'
import { ApiError } from '../lib/api'

const note: Note = {
  id: '01m1r8923zajxnw9y0dhs6sy8j', title: 'Example', excerpt: 'old', content: 'old',
  folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false,
  wordCount: 1, charCount: 3, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}
function sync(remote: Note): SyncResponse {
  const { content: _content, ...summary } = remote
  return { cursor: remote.rev, full: false, hasMore: false, nextKey: null, facetsFull: false,
    settingsChanged: false, profileChanged: false, siteChanged: false, notes: [summary],
    folders: [], tags: [], deletions: [], serverTime: 1 }
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.queue = []
  mocks.get.mockReset(); mocks.patch.mockReset(); mocks.create.mockReset()
  useNotes.setState({ notes: { [note.id]: note }, contents: { [note.id]: note.content },
    folders: [], tags: [], cursor: 1, pendingCount: 0, online: true })
})
afterEach(() => vi.useRealTimers())

it('moves every note of a deleted folder in a single store write', async () => {
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
    const id = `bulk-${index}`
    return [id, { ...note, id, title: id, folderId: 'folder-a' }]
  }))
  useNotes.setState({
    notes: many,
    folders: [{ id: 'folder-a', parentId: 'folder-b', name: 'A', icon: null, color: null,
      position: 0, createdAt: 1, updatedAt: 1 } as any],
  })
  let notifications = 0
  const unsubscribe = useNotes.subscribe(() => { notifications++ })
  const written: Array<string> = []
  mocks.patch.mockImplementation(async (id: string) => { written.push(id); return many[id] })
  expect(useNotes.getState().deleteFolder('folder-a')).toBe(true)
  unsubscribe()
  // One write for the 500 optimistic patches, one for the folder removal itself.
  expect(notifications).toBeLessThanOrEqual(2)
  const after = useNotes.getState().notes
  expect(Object.values(after).every((item) => item.folderId === 'folder-b')).toBe(true)
})

it('keeps the loaded content revision until remote content arrives', async () => {
  let resolve!: (value: Note) => void
  mocks.get.mockImplementation(() => new Promise<Note>((done) => { resolve = done }))
  const remote = { ...note, rev: 2, content: 'remote edit' }
  useNotes.getState().applySync(sync(remote))
  expect(useNotes.getState().notes[note.id].rev).toBe(1)
  expect(useNotes.getState().contents[note.id]).toBe('old')
  expect(mocks.get).toHaveBeenCalledWith(note.id)
  resolve(remote)
  await vi.waitFor(() => expect(useNotes.getState().contents[note.id]).toBe('remote edit'))
  expect(useNotes.getState().notes[note.id].rev).toBe(2)
})

it('saves conflicting local edits as a copy without retrying over the server note', async () => {
  useNotes.getState().editContent(note.id, 'offline local edit')
  const remote = { ...note, rev: 3, content: 'remote important edit' }
  mocks.patch.mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict', { server: remote }))
  mocks.create.mockImplementation(async (input) => ({ ...note, ...input, rev: 1 }))
  await useNotes.getState().flush({ immediate: true })
  expect(mocks.patch).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ content: 'offline local edit' }))
  expect(useNotes.getState().contents[note.id]).toBe('remote important edit')
  expect(useNotes.getState().notes[note.id].rev).toBe(3)
  expect(mocks.queue).toHaveLength(0)
})

it('recomputes the sidebar tag count the moment the tag leaves the note body', () => {
  useNotes.setState({
    notes: { [note.id]: { ...note, tags: ['demo'] } },
    contents: { [note.id]: 'alpha #demo omega' },
    tags: [{ id: 't-demo', name: 'demo', color: null, count: 3, createdAt: 1 }],
  })
  useNotes.getState().editContent(note.id, 'alpha omega')
  vi.advanceTimersByTime(200)
  expect(useNotes.getState().notes[note.id].tags).toEqual([])
  expect(useNotes.getState().tags[0].count).toBe(2)
})

it('moves counts across a case difference instead of splitting one tag in two', () => {
  useNotes.setState({
    notes: { [note.id]: { ...note, tags: ['Inkstone'] } },
    contents: { [note.id]: 'body #Inkstone' },
    tags: [
      { id: 't-inkstone', name: 'Inkstone', color: null, count: 1, createdAt: 1 },
      { id: 't-demo', name: 'Demo', color: null, count: 1, createdAt: 1 },
    ],
  })
  useNotes.getState().editContent(note.id, 'body #DEMO')
  vi.advanceTimersByTime(200)
  const tags = useNotes.getState().tags
  expect(tags.find((item) => item.id === 't-inkstone')!.count).toBe(0)
  expect(tags.find((item) => item.id === 't-demo')!.count).toBe(2)
})

it('leaves the counts untouched while editing a note that the archive excludes', () => {
  useNotes.setState({
    notes: { [note.id]: { ...note, isArchived: true, tags: ['demo'] } },
    contents: { [note.id]: 'body #demo' },
    tags: [{ id: 't-demo', name: 'demo', color: null, count: 5, createdAt: 1 }],
  })
  useNotes.getState().editContent(note.id, 'body')
  vi.advanceTimersByTime(200)
  expect(useNotes.getState().notes[note.id].tags).toEqual([])
  expect(useNotes.getState().tags[0].count).toBe(5)
})
