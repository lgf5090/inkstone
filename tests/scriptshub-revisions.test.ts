// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCRIPTSHUB_SCHEMA_STATEMENTS } from '../src/worker/scriptshub/schema'
import { ScriptsHubStore } from '../src/worker/scriptshub/store'
import { makeD1 } from './doubles/d1-sqlite'

const ME = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let store: ScriptsHubStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCRIPTSHUB_SCHEMA_STATEMENTS.join(';'))
  store = new ScriptsHubStore(makeD1(sqlite), ME)
})

async function withFiles(snippetId: string, files: Array<{ id?: string; name: string; content: string }>, title = 'Script') {
  const detail = await store.getSnippet(snippetId)
  return store.saveSnippet(snippetId, {
    title,
    description: detail.description,
    folderId: detail.folderId,
    language: 'shell',
    sourceUrl: detail.sourceUrl,
    notes: detail.notes,
    tags: [],
    files: files.map((file) => ({
      ...(file.id ? { id: file.id } : {}),
      name: file.name,
      language: 'shell' as const,
      content: file.content,
    })),
  })
}

describe('a save only spends a version when something changed', () => {
  it('does not add a revision when the files, title and description are unchanged', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    const saved = await withFiles(created.id, [{ id: first.id, name: first.name, content: 'echo one\n' }])
    expect(saved.revisionCount).toBe(2)
    const again = await withFiles(created.id, [{ id: first.id, name: first.name, content: 'echo one\n' }])
    expect(again.revisionCount).toBe(2)
    expect(again.files[0]!.content).toBe('echo one\n')
  })

  it('writes a new revision when a file changes, and records the line counts', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    const saved = await withFiles(created.id, [{ id: first.id, name: first.name, content: 'one\ntwo\n' }])
    expect(saved.revisionCount).toBe(2)
    const changed = await withFiles(created.id, [{ id: first.id, name: first.name, content: 'one\ntwo\nthree\n' }])
    expect(changed.revisionCount).toBe(3)
    const revisions = await store.listRevisions(created.id)
    expect(revisions[0]!.added).toBe(1)
    expect(revisions[0]!.removed).toBe(0)
    expect(revisions[1]!.added).toBe(2)
  })

  it('keeps one version for a multi-file save and snapshots every file', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    const saved = await withFiles(created.id, [
      { id: first.id, name: 'main.sh', content: 'main\n' },
      { name: 'helper.sh', content: 'helper\n' },
    ])
    expect(saved.revisionCount).toBe(2)
    const snapshot = await store.readRevision(created.id, 2)
    expect(snapshot.files.map((file) => file.name).sort()).toEqual(['helper.sh', 'main.sh'])
  })

  it('restoring an older version writes a new version rather than rewinding', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    await withFiles(created.id, [{ id: first.id, name: first.name, content: 'v1\n' }])
    await withFiles(created.id, [{ id: first.id, name: first.name, content: 'v2\n' }])
    const restored = await store.restoreRevision(created.id, 2)
    expect(restored.revisionCount).toBe(4)
    expect(restored.files[0]!.content).toBe('v1\n')
    const versions = (await store.listRevisions(created.id)).map((revision) => revision.version)
    expect(versions).toEqual([4, 3, 2, 1])
  })

  it('does not re-add the head snapshot when the same version is restored twice', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    await withFiles(created.id, [{ id: first.id, name: first.name, content: 'v1\n' }])
    await store.restoreRevision(created.id, 2)
    const count = (await store.listRevisions(created.id)).length
    await store.restoreRevision(created.id, 2)
    expect((await store.listRevisions(created.id)).length).toBe(count)
  })
})

describe('renaming never carries a distribution path with it', () => {
  it('keeps the path, the file identity and the revisions', async () => {
    const created = await store.createSnippet({ title: 'Original', language: 'shell' })
    const first = created.files[0]!
    await withFiles(created.id, [{ id: first.id, name: first.name, content: 'echo hi\n' }])
    const publication = await store.createPublication(created.id, {
      fileId: first.id,
      path: 'system/linux/setup.sh',
      visibility: 'public',
    })
    const renamed = await store.saveSnippet(created.id, {
      title: 'Renamed',
      description: '',
      folderId: null,
      language: 'shell',
      sourceUrl: '',
      notes: '',
      tags: [],
      files: [{ id: first.id, name: first.name, language: 'shell', content: 'echo hi\n' }],
    })
    expect(renamed.title).toBe('Renamed')
    expect(renamed.publications[0]?.path).toBe(publication.path)
    // A title is part of a version, so the rename is one more version — under the same snippet id,
    // which is what keeps the whole history attached to the renamed snippet.
    expect(renamed.revisionCount).toBe(3)
    const revisions = await store.listRevisions(created.id)
    expect(revisions[0]!.title).toBe('Renamed')
  })

  it('refuses a second path that differs only by case', async () => {
    const created = await store.createSnippet({ title: 'Script', language: 'shell' })
    const first = created.files[0]!
    await store.createPublication(created.id, { fileId: first.id, path: 'system/linux/setup.sh', visibility: 'public' })
    await expect(store.createPublication(created.id, {
      fileId: first.id,
      path: 'System/Linux/Setup.sh',
      visibility: 'public',
    })).rejects.toThrow(/already has a distribution|already in use/i)
  })
})

describe('deleting a folder keeps what it held reachable', () => {
  it('moves nested folders and snippets to the parent', async () => {
    const root = await store.createFolder({ name: 'root' })
    const child = await store.createFolder({ name: 'child', parentId: root.id })
    const snippet = await store.createSnippet({ title: 'Script', language: 'shell', folderId: child.id })
    await store.deleteFolder(child.id)
    const folders = await store.listFolders()
    const detail = await store.getSnippet(snippet.id)
    expect(detail.folderId).toBe(root.id)
    expect(folders.some((folder) => folder.id === child.id)).toBe(false)
  })

  it('does not touch another account', async () => {
    const other = new ScriptsHubStore(makeD1(sqlite), OTHER)
    const mine = await store.createFolder({ name: 'mine' })
    const theirs = await other.createSnippet({ title: 'theirs', language: 'shell' })
    await store.deleteFolder(mine.id)
    await expect(other.getSnippet(theirs.id)).resolves.toBeTruthy()
    await expect(store.getSnippet(theirs.id)).rejects.toThrow(/not found/i)
  })
})
