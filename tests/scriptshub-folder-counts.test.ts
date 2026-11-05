// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCRIPTSHUB_SCHEMA_STATEMENTS } from '../src/worker/scriptshub/schema'
import { ScriptsHubStore } from '../src/worker/scriptshub/store'
import { makeD1 } from './doubles/d1-sqlite'

const ME = 'user-a'

let sqlite: DatabaseSync
let store: ScriptsHubStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCRIPTSHUB_SCHEMA_STATEMENTS.join(';'))
  store = new ScriptsHubStore(makeD1(sqlite), ME)
})

async function makeSnippet(title: string, folderId: string | null = null) {
  return store.createSnippet({ title, folderId, language: 'shell' })
}

async function folderCounts() {
  const folders = await store.listFolders()
  return Object.fromEntries(folders.map((folder) => [folder.name, folder.snippetCount]))
}

describe('a move re-counts both folders on the next read', () => {
  it('decrements the source and increments the target for one snippet', async () => {
    const source = await store.createFolder({ name: 'source' })
    const target = await store.createFolder({ name: 'target' })
    const snippet = await makeSnippet('moves', source.id)
    expect(await folderCounts()).toMatchObject({ source: 1, target: 0 })

    await store.updateSnippet(snippet.id, { folderId: target.id })

    expect(await folderCounts()).toMatchObject({ source: 0, target: 1 })
  })

  it('re-counts for a batch move without waiting for another request', async () => {
    const source = await store.createFolder({ name: 'source' })
    const target = await store.createFolder({ name: 'target' })
    const first = await makeSnippet('first', source.id)
    const second = await makeSnippet('second', source.id)
    expect(await folderCounts()).toMatchObject({ source: 2, target: 0 })

    await store.batch({ action: 'move', ids: [first.id, second.id], folderId: target.id })

    expect(await folderCounts()).toMatchObject({ source: 0, target: 2 })
  })

  it('keeps the tag counts in step when a snippet changes tags', async () => {
    const tag = await store.createTag({ name: 'ops' })
    const snippet = await makeSnippet('tagged')
    expect((await store.listTags()).find((entry) => entry.id === tag.id)?.snippetCount).toBe(0)

    await store.updateSnippet(snippet.id, { tags: [tag.id] })
    expect((await store.listTags()).find((entry) => entry.id === tag.id)?.snippetCount).toBe(1)

    await store.updateSnippet(snippet.id, { tags: [] })
    expect((await store.listTags()).find((entry) => entry.id === tag.id)?.snippetCount).toBe(0)
  })

  it('re-counts the parent when a folder is deleted and its snippets move up', async () => {
    const parent = await store.createFolder({ name: 'parent' })
    const child = await store.createFolder({ name: 'child', parentId: parent.id })
    await makeSnippet('inside', child.id)
    expect(await folderCounts()).toMatchObject({ parent: 0, child: 1 })

    await store.deleteFolder(child.id)

    expect(await folderCounts()).toMatchObject({ parent: 1 })
  })
})

describe('a folder keeps the slot the arrange menu asked for', () => {
  it('inserts at an explicit index and closes the gap behind it', async () => {
    await store.createFolder({ name: 'alpha' })
    const beta = await store.createFolder({ name: 'beta' })
    await store.createFolder({ name: 'gamma' })

    await store.updateFolder(beta.id, { position: 0 })
    expect((await store.listFolders()).map((folder) => folder.name)).toEqual(['beta', 'alpha', 'gamma'])

    await store.updateFolder(beta.id, { position: 2 })
    expect((await store.listFolders()).map((folder) => folder.name)).toEqual(['alpha', 'gamma', 'beta'])
  })

  it('appends at the end when a folder moves into a new parent', async () => {
    const parent = await store.createFolder({ name: 'parent' })
    const first = await store.createFolder({ name: 'first', parentId: parent.id })
    const moving = await store.createFolder({ name: 'moving' })

    await store.updateFolder(moving.id, { parentId: parent.id })

    const children = (await store.listFolders()).filter((folder) => folder.parentId === parent.id)
    expect(children.map((folder) => folder.name)).toEqual([first.name, moving.name])
  })

  it('clamps an out-of-range slot instead of writing it', async () => {
    const only = await store.createFolder({ name: 'only' })
    await store.updateFolder(only.id, { position: 99 })
    expect((await store.listFolders()).find((folder) => folder.id === only.id)?.position).toBe(0)
  })
})
