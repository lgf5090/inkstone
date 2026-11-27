import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'

const idb = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (key: string) => idb.values.get(key),
  set: async (key: string, value: unknown) => { idb.values.set(key, value) },
  del: async (key: string) => { idb.values.delete(key) },
  clear: async () => { idb.values.clear() },
  getMany: async (keys: string[]) => keys.map((key) => idb.values.get(key)),
  setMany: async (entries: Array<[string, unknown]>) => { for (const [key, value] of entries) idb.values.set(key, value) },
  update: async (key: string, updater: (current: unknown) => unknown) => { idb.values.set(key, updater(idb.values.get(key))) },
}))
import { localDb } from './db'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const bundle: ProjectBoardBundle = {
  board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'Cached', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, archived: false, ...stamps },
  properties: [], views: [{ id: 'v1', boardId: 'b1', title: 'List', viewType: 'list', fields: emptyProjectViewFields(), position: 0, ...stamps }],
  cards: [], contents: [], comments: [], members: [], people: {}, role: 'viewer', cursor: 1, propertyRevision: 1,
}

beforeEach(() => { idb.values.clear() })

describe('project board cache storage', () => {
  it('keeps cached boards isolated by account', async () => {
    await localDb.bindUser('u1')
    await localDb.setProjectBoardCache('b1', { bundle, loadedCursors: ['page-2'], savedAt: 10 })
    expect(await localDb.getProjectBoardCache('b1')).toEqual({ bundle, loadedCursors: ['page-2'], savedAt: 10 })
    await localDb.bindUser('u2')
    expect(await localDb.getProjectBoardCache('b1')).toBeUndefined()
  })

  it('does not let a delayed older snapshot replace a newer cached board', async () => {
    await localDb.bindUser('u1')
    await localDb.setProjectBoardCache('b1', { bundle: { ...bundle, cursor: 2 }, loadedCursors: [], savedAt: 2 })
    await localDb.setProjectBoardCache('b1', { bundle, loadedCursors: [], savedAt: 1 })
    expect((await localDb.getProjectBoardCache('b1'))?.bundle.cursor).toBe(2)
  })

  it('ignores a malformed cache record', async () => {
    await localDb.bindUser('u1')
    idb.values.set('projectBoard:b1', { bundle: { id: 'other' }, loadedCursors: [] })
    expect(await localDb.getProjectBoardCache('b1')).toBeUndefined()
  })
})
