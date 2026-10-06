import { beforeEach, describe, expect, it, vi } from 'vitest'

const kv = vi.hoisted(() => ({ data: new Map<string, unknown>() }))

vi.mock('idb-keyval', () => {
  const asMap = (store: unknown) => (store as { __map?: Map<string, unknown> } | undefined)?.__map ?? kv.data
  return {
    createStore: (name: string) => ({ name, __map: kv.data }),
    get: async (key: string, store: unknown) => asMap(store).get(key),
    set: async (key: string, value: unknown, store: unknown) => { asMap(store).set(key, value) },
    setMany: async (entries: [string, unknown][], store: unknown) => {
      for (const [key, value] of entries) asMap(store).set(key, value)
    },
    getMany: async (keys: string[], store: unknown) => keys.map((key) => asMap(store).get(key)),
    del: async (key: string, store: unknown) => { asMap(store).delete(key) },
    delMany: async (keys: string[], store: unknown) => { for (const key of keys) asMap(store).delete(key) },
    clear: async (store: unknown) => { asMap(store).clear() },
    update: async (key: string, updater: (value: unknown) => unknown, store: unknown) => {
      asMap(store).set(key, updater(asMap(store).get(key)))
    },
    entries: async (store: unknown) => [...asMap(store).entries()],
  }
})

const TEMPLATE = {
  id: 'tpl-1',
  categoryId: null,
  name: 'Kept',
  description: '',
  content: '# Body',
  builtin: false,
  isPinned: false,
  isStarred: false,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

const CATEGORY = { id: 'cat-1', name: 'Folder', builtin: false, position: 0, createdAt: 1 }

async function db() {
  return (await import('../src/client/lib/db')).localDb
}

const scoped = (userId: string) => `user:${userId}:templateLibrary`

beforeEach(() => {
  kv.data.clear()
})

describe('the stored template library', () => {
  it('returns null before anything has been saved', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    expect(await localDb.loadTemplateLibrary()).toBe(null)
  })

  it('round-trips a library', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    const data = { categories: [CATEGORY], templates: [TEMPLATE], seedVersion: 3 }
    await localDb.saveTemplateLibrary(data)
    expect(await localDb.loadTemplateLibrary()).toEqual(data)
  })

  it('keeps one library per account', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    await localDb.saveTemplateLibrary({
      categories: [],
      templates: [TEMPLATE],
      seedVersion: 1,
    })
    await localDb.bindUser('user-b')
    expect(await localDb.loadTemplateLibrary()).toBe(null)
    await localDb.saveTemplateLibrary({
      categories: [],
      templates: [{ ...TEMPLATE, id: 'tpl-b', name: 'Account B' }],
      seedVersion: 1,
    })
    await localDb.bindUser('user-a')
    expect((await localDb.loadTemplateLibrary())?.templates.map((item) => item.name)).toEqual(['Kept'])
    await localDb.bindUser('user-b')
    expect((await localDb.loadTemplateLibrary())?.templates.map((item) => item.name)).toEqual(['Account B'])
  })

  it('drops entries whose fields no longer match, keeping the rest', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    kv.data.set(scoped('user-a'), {
      categories: [CATEGORY, { id: 'cat-2', name: 7, builtin: false, position: 0, createdAt: 0 }],
      templates: [
        TEMPLATE,
        { ...TEMPLATE, id: 'no-name', name: 42 },
        { ...TEMPLATE, id: 'bad-pin', isPinned: 'yes' },
        { ...TEMPLATE, id: 'bad-tags', tags: ['ok', 5] },
        { ...TEMPLATE, id: 'bad-position', position: Number.NaN },
        'not even an object',
      ],
      seedVersion: 2,
    })
    const loaded = await localDb.loadTemplateLibrary()
    expect(loaded?.templates.map((item) => item.id)).toEqual(['tpl-1'])
    expect(loaded?.categories.map((item) => item.id)).toEqual(['cat-1'])
    expect(loaded?.seedVersion).toBe(2)
  })

  it('treats a missing or unreadable seed version as unseeded', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    kv.data.set(scoped('user-a'), { categories: [], templates: [TEMPLATE] })
    expect((await localDb.loadTemplateLibrary())?.seedVersion).toBe(0)
    kv.data.set(scoped('user-a'), { categories: [], templates: [], seedVersion: 'two' })
    expect((await localDb.loadTemplateLibrary())?.seedVersion).toBe(0)
  })

  it('reads a hand-edited record as an empty library rather than throwing', async () => {
    const localDb = await db()
    await localDb.bindUser('user-a')
    for (const junk of [null, 'a string', 42, true]) {
      kv.data.set(scoped('user-a'), junk)
      expect(await localDb.loadTemplateLibrary()).toBe(null)
    }
    for (const junk of [[], { categories: 'no', templates: 5, seedVersion: {} }]) {
      kv.data.set(scoped('user-a'), junk)
      expect(await localDb.loadTemplateLibrary()).toEqual(
        Array.isArray(junk) ? null : { categories: [], templates: [], seedVersion: 0 },
      )
    }
  })

  it('carries an un-namespaced library into the account that already owns it', async () => {
    const localDb = await db()
    // The migration only runs on the bind that switches accounts, so start from
    // a different one to make this case independent of test order.
    await localDb.bindUser('someone-else')
    kv.data.clear()
    kv.data.set('userId', 'user-a')
    kv.data.set('templateLibrary', { categories: [], templates: [TEMPLATE], seedVersion: 1 })
    await localDb.bindUser('user-a')
    expect((await localDb.loadTemplateLibrary())?.templates.map((item) => item.id)).toEqual(['tpl-1'])
    expect(kv.data.has('templateLibrary')).toBe(false)
    expect(kv.data.has(scoped('user-a'))).toBe(true)
  })
})
