// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'

const idb = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  writes: [] as Array<[string, unknown]>,
  fail: false,
}))

vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (key: string) => idb.values.get(key),
  set: async (key: string, value: unknown) => { idb.values.set(key, value) },
  del: async (key: string) => { idb.values.delete(key) },
  clear: async () => { idb.values.clear() },
  getMany: async (keys: string[]) => keys.map((key) => idb.values.get(key)),
  setMany: async (entries: Array<[string, unknown]>) => {
    if (idb.fail) throw new Error('write refused')
    for (const [key, value] of entries) {
      idb.values.set(key, value)
      idb.writes.push([key, value])
    }
  },
  update: async (key: string, updater: (current: unknown) => unknown) => {
    idb.values.set(key, updater(idb.values.get(key)))
  },
}))

import { localDb } from './db'

function summary(index: number): NoteSummary {
  return {
    id: `note-${index}`,
    title: `Note ${index}`,
    excerpt: `Body ${index}`,
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 2,
    charCount: 6,
    rev: 1,
    position: index,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

const facets = { folders: [], tags: [], cursor: 0 }

beforeEach(async () => {
  await localDb.clear()
  idb.values.clear()
  idb.writes = []
  idb.fail = false
  const session = {
    user: { id: 'user-1', login: 'user', name: 'User', avatarUrl: '', role: 'owner', createdAt: 1, username: 'user' },
    site: { name: 'Inkstone', initialized: true, registrationOpen: false, r2Enabled: false, kvEnabled: false,
      attachmentStorage: null, realtimeEnabled: false, version: 'test' },
    settings: null,
  }
  idb.values.set('userId', 'user-1')
  idb.values.set('session', session)
  expect(await localDb.loadSession()).toEqual(session)
})

describe('keyed local note shell', () => {
  it('writes one key per note and reloads from the authoritative index', async () => {
    const notes = Array.from({ length: 100 }, (_, index) => summary(index))
    expect(await localDb.saveShell({ notes, ...facets }, 'user-1')).toBe(true)
    expect(idb.writes.filter(([key]) => key.startsWith('shell-note-v2:'))).toHaveLength(100)
    expect(idb.writes.some(([key]) => key === 'shell-note-index-v2')).toBe(true)

    expect(await localDb.loadShell()).toEqual({ notes, ...facets })
  })

  it('writes only the changed note when membership is unchanged', async () => {
    const notes = Array.from({ length: 100 }, (_, index) => summary(index))
    await localDb.saveShell({ notes, ...facets }, 'user-1')
    idb.writes = []
    const changed = { ...notes[0]!, excerpt: 'Changed body' }

    expect(await localDb.saveShell({ notes: [changed, ...notes.slice(1)], ...facets }, 'user-1')).toBe(true)
    expect(idb.writes.filter(([key]) => key.startsWith('shell-note-v2:'))).toEqual([
      ['shell-note-v2:note-0', changed],
    ])
    expect(idb.writes.some(([key]) => key === 'shell-note-index-v2')).toBe(false)
    expect((await localDb.loadShell())?.notes[0]).toEqual(changed)
  })

  it('updates only the index when a note is removed', async () => {
    const notes = Array.from({ length: 3 }, (_, index) => summary(index))
    await localDb.saveShell({ notes, ...facets }, 'user-1')
    idb.writes = []

    await localDb.saveShell({ notes: notes.slice(1), ...facets }, 'user-1')
    expect(idb.writes.filter(([key]) => key.startsWith('shell-note-v2:'))).toEqual([])
    expect(idb.writes.some(([key]) => key === 'shell-note-index-v2')).toBe(true)
    expect((await localDb.loadShell())?.notes.map((note) => note.id)).toEqual(['note-1', 'note-2'])
  })

  it('migrates a legacy whole-array shell on the next save', async () => {
    const notes = [summary(0), summary(1)]
    idb.values.set('notes', notes)
    idb.values.set('folders', [])
    idb.values.set('tags', [])
    idb.values.set('cursor', 0)
    expect(await localDb.loadShell()).toEqual({ notes, ...facets })

    idb.writes = []
    await localDb.saveShell({ notes, ...facets }, 'user-1')
    expect(idb.writes.filter(([key]) => key.startsWith('shell-note-v2:'))).toHaveLength(2)
    expect(idb.writes.some(([key]) => key === 'shell-note-index-v2')).toBe(true)
  })

  it('does not advance the differential cache after a failed write', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notes = [summary(0)]
    idb.fail = true
    expect(await localDb.saveShell({ notes, ...facets }, 'user-1')).toBe(false)
    expect(warning).toHaveBeenCalled()

    idb.fail = false
    idb.writes = []
    expect(await localDb.saveShell({ notes, ...facets }, 'user-1')).toBe(true)
    expect(idb.writes.filter(([key]) => key.startsWith('shell-note-v2:'))).toHaveLength(1)
    warning.mockRestore()
  })
})
