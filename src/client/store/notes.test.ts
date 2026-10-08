import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Note, SyncResponse } from '@shared/types'

const mocks = vi.hoisted(() => ({
  queue: [] as any[],
  get: vi.fn(),
  patch: vi.fn(),
  create: vi.fn(),
  linkMention: vi.fn(),
}))
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
  return { ...actual, api: { ...actual.api, notes: { get: mocks.get, patch: mocks.patch, create: mocks.create, linkMention: mocks.linkMention } } }
})
import { useNotes } from './notes'
import { api } from '../lib/api'
import { getInboxFolderId, setInboxFolderId } from '../lib/folder-prefs'
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
/**
 * The link tests write to a note of their own. `dirty` is module state and outlives the
 * per-test `setState`, so a note an earlier test typed into is still unsaved here, and the
 * guard under test would trip for that reason instead of the one being measured.
 */
const PRISTINE = '01pristinenote'
function withPristineNote(content: string): void {
  useNotes.setState((state) => ({
    notes: { ...state.notes, [PRISTINE]: { ...note, id: PRISTINE, content, excerpt: content } },
    contents: { ...state.contents, [PRISTINE]: content },
  }))
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.queue = []
  mocks.get.mockReset(); mocks.patch.mockReset(); mocks.create.mockReset(); mocks.linkMention.mockReset()
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

it('forgets the inbox folder only once its deletion is confirmed', async () => {
  const folderA = { id: 'folder-a', parentId: null, name: 'A', icon: null, color: null,
    position: 0, createdAt: 1, updatedAt: 1 }
  setInboxFolderId('folder-a')
  useNotes.setState({ folders: [folderA] })
  const remove = vi.spyOn(api.folders, 'remove').mockResolvedValue({ ok: true })
  expect(useNotes.getState().deleteFolder('folder-a')).toBe(true)
  expect(getInboxFolderId()).toBe('folder-a')
  await vi.waitFor(() => expect(getInboxFolderId()).toBeNull())
  expect(remove).toHaveBeenCalledWith('folder-a', 'move-up')
  remove.mockRestore()
})

it('keeps the inbox folder when the deletion is refused', async () => {
  const folderA = { id: 'folder-a', parentId: null, name: 'A', icon: null, color: null,
    position: 0, createdAt: 1, updatedAt: 1 }
  setInboxFolderId('folder-a')
  useNotes.setState({ folders: [folderA] })
  const remove = vi.spyOn(api.folders, 'remove').mockRejectedValue(new ApiError(500, 'boom', 'boom'))
  expect(useNotes.getState().deleteFolder('folder-a')).toBe(true)
  await vi.waitFor(() => expect(remove).toHaveBeenCalled())
  expect(getInboxFolderId()).toBe('folder-a')
  remove.mockRestore()
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

it('takes the linked text the server wrote back into the note it belongs to', async () => {
  withPristineNote('see Example now')
  mocks.linkMention.mockResolvedValue({
    status: 'linked',
    note: { ...note, id: PRISTINE, rev: 2, content: 'see [[Example]] now', excerpt: 'see Example now', updatedAt: 5 },
  })
  expect(await useNotes.getState().linkMention('01targetnote', PRISTINE)).toBe('linked')
  expect(mocks.linkMention).toHaveBeenCalledWith('01targetnote', PRISTINE)
  expect(useNotes.getState().contents[PRISTINE]).toBe('see [[Example]] now')
  expect(useNotes.getState().notes[PRISTINE].rev).toBe(2)
})

it('reports a gone mention without rewriting the note', async () => {
  withPristineNote('see Example now')
  mocks.linkMention.mockResolvedValue({ status: 'no-mention' })
  expect(await useNotes.getState().linkMention('01targetnote', PRISTINE)).toBe('none')
  expect(useNotes.getState().contents[PRISTINE]).toBe('see Example now')
  expect(useNotes.getState().notes[PRISTINE].rev).toBe(1)
})

it('waits for a write still travelling on that note instead of linking over it', async () => {
  withPristineNote('see Example now')
  const realFlush = useNotes.getState().flush
  useNotes.setState({ flush: async () => {} })
  mocks.queue.push({ id: 'w1', writeId: 'w1', noteId: PRISTINE, payload: {} })
  expect(await useNotes.getState().linkMention('01targetnote', PRISTINE)).toBe('error')
  expect(mocks.linkMention).not.toHaveBeenCalled()
  expect(useNotes.getState().contents[PRISTINE]).toBe('see Example now')
  useNotes.setState({ flush: realFlush })
})

it('leaves the note untouched when the link request cannot be made', async () => {
  withPristineNote('see Example now')
  mocks.linkMention.mockRejectedValue(new ApiError(500, 'internal', 'boom'))
  expect(await useNotes.getState().linkMention('01targetnote', PRISTINE)).toBe('error')
  expect(useNotes.getState().contents[PRISTINE]).toBe('see Example now')
  expect(useNotes.getState().notes[PRISTINE].rev).toBe(1)
})
