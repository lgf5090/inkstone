import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxItem } from './db'

const idb = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  transactions: 0,
}))

vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (key: string) => idb.values.get(key),
  set: async (key: string, value: unknown) => { idb.values.set(key, value) },
  del: async (key: string) => { idb.values.delete(key) },
  clear: async () => { idb.values.clear() },
  getMany: async (keys: string[]) => keys.map((key) => idb.values.get(key)),
  setMany: async (entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) idb.values.set(key, value)
  },
  update: async (key: string, updater: (current: unknown) => unknown) => {
    idb.transactions++
    idb.values.set(key, updater(idb.values.get(key)))
  },
}))

import { localDb } from './db'

function item(id: string, writeId = `write:${id}`, createdAt = 1): OutboxItem {
  return {
    id,
    clientId: 'client',
    writeId,
    entity: 'note',
    entityId: `note:${id}`,
    payload: { rev: 1, content: id },
    attempts: 0,
    createdAt,
  }
}

function queue(): OutboxItem[] {
  return idb.values.get('outbox') as OutboxItem[]
}

beforeEach(() => {
  idb.values.clear()
  idb.transactions = 0
})

describe('localDb outbox batches', () => {
  it('merges a 10k queue in one Map pass and preserves remove-and-append order and createdAt', async () => {
    const original = Array.from({ length: 10_000 }, (_, index) => item(`row-${index}`, `write-${index}`, index + 1))
    await localDb.enqueueOutboxBatch(original)
    idb.transactions = 0

    // The old implementation called find/filter for every incoming row. Watching the prototypes
    // catches a regression directly instead of relying on a noisy wall-clock budget.
    const find = vi.spyOn(Array.prototype, 'find')
    const filter = vi.spyOn(Array.prototype, 'filter')
    try {
      await localDb.enqueueOutboxBatch([
        item('row-9999', 'replacement-a', 20_000),
        item('row-0', 'replacement-b', 20_001),
        item('row-9999', 'replacement-c', 20_002),
        item('new-row', 'new-write', 20_003),
      ])
      expect(find).not.toHaveBeenCalled()
      expect(filter).not.toHaveBeenCalled()
    } finally {
      find.mockRestore()
      filter.mockRestore()
    }

    expect(idb.transactions).toBe(1)
    expect(queue()).toHaveLength(10_001)
    expect(queue().slice(0, 3).map((entry) => entry.id)).toEqual(['row-1', 'row-2', 'row-3'])
    expect(queue().slice(-3).map((entry) => [entry.id, entry.writeId, entry.createdAt])).toEqual([
      ['row-0', 'replacement-b', 1],
      ['row-9999', 'replacement-c', 10_000],
      ['new-row', 'new-write', 20_003],
    ])
  })

  it('completes a wave in one transaction using exact (id, writeId) identities', async () => {
    await localDb.enqueueOutboxBatch(Array.from({ length: 10_000 }, (_, index) => item(`row-${index}`)))
    idb.transactions = 0
    const completed = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, writeId: `write:row-${index}` }))

    await localDb.completeOutboxBatch(completed)

    expect(idb.transactions).toBe(1)
    expect(queue()).toHaveLength(9_900)
    expect(queue().some((entry) => completed.some((done) => done.id === entry.id))).toBe(false)
  })

  it('is idempotent across crash/replay and never removes a newer write reusing an id', async () => {
    await localDb.enqueueOutboxBatch([item('same-id', 'crashed-write'), item('other-id', 'other-write')])
    const completion = [{ id: 'same-id', writeId: 'crashed-write' }, { id: 'other-id', writeId: 'other-write' }]

    // The server accepted the wave, but the tab crashed before this transaction landed. Replaying
    // the same completion is harmless and leaves no duplicate row behind.
    await localDb.completeOutboxBatch(completion)
    await localDb.completeOutboxBatch(completion)
    expect(queue()).toEqual([])

    await localDb.enqueueOutboxBatch([item('same-id', 'newer-write', 2)])
    await localDb.completeOutboxBatch([{ id: 'same-id', writeId: 'crashed-write' }])
    expect(queue().map((entry) => entry.writeId)).toEqual(['newer-write'])

    // Pair encoding must not collide when an id itself contains the separator.
    await localDb.enqueueOutboxBatch([item('a\u0000b', 'c'), item('a', 'b\u0000c')])
    await localDb.completeOutboxBatch([{ id: 'a\u0000b', writeId: 'c' }])
    expect(queue().map((entry) => [entry.id, entry.writeId])).toEqual([
      ['same-id', 'newer-write'],
      ['a', 'b\u0000c'],
    ])
  })
})
