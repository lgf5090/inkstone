// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import {
  batchUpdateGists,
  collectDescendantTagIds,
  deleteExpiredExports,
  deleteGistTags,
  deleteGists,
  deleteRepo,
  deleteTags,
  findExport,
  findGist,
  findMissingGistTagIds,
  findMissingTagIds,
  findRepo,
  findTag,
  insertExport,
  listExpiredExports,
  listExports,
  listGists,
  listGistTags,
  listRepos,
  listTags,
  unbindGistTags,
  unbindRepoTags,
  upsertGist,
  upsertGistTag,
  upsertRepo,
  upsertTag,
} from '../src/worker/development/github/store'
import type { GistUpsert, RepoUpsert } from '../src/worker/development/github/store'
import { MAX_TAGS } from '../src/shared/development/github/limits'
import type { GistItem, GithubRepo } from '../src/shared/development/github/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-a'
const USER_B = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

function repoData(id: number): GithubRepo {
  return {
    id,
    name: `repo-${id}`,
    fullName: `owner/repo-${id}`,
    url: `https://github.com/owner/repo-${id}`,
    description: null,
    homepage: null,
    owner: { login: 'owner', avatarUrl: '' },
    language: 'TypeScript',
    stargazersCount: 1,
    forksCount: 0,
    openIssuesCount: 0,
    topics: [],
    license: null,
    isArchived: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    defaultBranch: 'main',
    size: 10,
  }
}

function gistData(id: string): GistItem {
  return {
    id,
    description: `gist ${id}`,
    url: `https://gist.github.com/${id}`,
    isPublic: true,
    owner: { login: 'owner', avatarUrl: '' },
    files: [{ filename: 'a.txt', language: null, content: 'hello', size: 5 }],
    fileCount: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  }
}

function repoInput(id: string, tagIds: string[] = []): RepoUpsert {
  return {
    id,
    fullName: `owner/repo-${id}`,
    url: `https://github.com/owner/repo-${id}`,
    data: repoData(Number(id)),
    tagIds,
    pinned: false,
    favorited: false,
  }
}

function gistInput(id: string, tagIds: string[] = []): GistUpsert {
  return {
    id,
    description: `gist ${id}`,
    url: `https://gist.github.com/${id}`,
    data: gistData(id),
    tagIds,
    pinned: false,
    favorited: false,
    notes: '',
  }
}

async function addTag(userId: string, id: string, parentId: string | null = null): Promise<void> {
  await upsertTag(db, userId, {
    id,
    name: id,
    color: '#64748b',
    parentId,
    sortOrder: 0,
  })
}

describe('development github tags', () => {
  it('upserts, preserves createdAt and isolates users', async () => {
    const created = await upsertTag(db, USER_A, {
      id: 'root',
      name: 'Root',
      color: '#112233',
      parentId: null,
      sortOrder: 1,
      createdAt: 1000,
    })
    expect(created.createdAt).toBe(1000)

    const updated = await upsertTag(db, USER_A, {
      id: 'root',
      name: 'Renamed',
      color: '#445566',
      parentId: null,
      sortOrder: 2,
      createdAt: 9000,
    })
    expect(updated.createdAt).toBe(1000)
    expect(updated.name).toBe('Renamed')
    expect(await listTags(db, USER_B)).toEqual([])
    expect(await findTag(db, USER_B, 'root')).toBeNull()
    expect((await listTags(db, USER_A))[0]?.name).toBe('Renamed')
  })

  it('collects descendants and deletes a tag tree while unbinding repositories', async () => {
    await addTag(USER_A, 'root')
    await addTag(USER_A, 'child', 'root')
    await addTag(USER_A, 'grandchild', 'child')
    await addTag(USER_A, 'other')
    await upsertRepo(db, USER_A, repoInput('1', ['child', 'grandchild', 'other']))
    await upsertRepo(db, USER_A, repoInput('2', ['other']))

    const tags = await listTags(db, USER_A)
    const removed = collectDescendantTagIds(tags, 'root')
    expect(removed.sort()).toEqual(['child', 'grandchild', 'root'])

    await deleteTags(db, USER_A, removed)
    const updated = await unbindRepoTags(db, USER_A, removed)
    expect(updated).toEqual(['1'])
    expect((await findRepo(db, USER_A, '1'))?.tagIds).toEqual(['other'])
    expect((await findRepo(db, USER_A, '2'))?.tagIds).toEqual(['other'])
    expect(await listTags(db, USER_A)).toEqual([expect.objectContaining({ id: 'other' })])
  })

  it('collects descendants without looping on a cycle', () => {
    const tags = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    expect(collectDescendantTagIds(tags, 'a').sort()).toEqual(['a', 'b'])
  })

  it('reports tag ids that do not belong to the user', async () => {
    await addTag(USER_A, 'tag-a')
    await addTag(USER_B, 'tag-b')
    expect(await findMissingTagIds(db, USER_A, ['tag-a', 'tag-b'])).toEqual(['tag-b'])
  })

  it('enforces the tag limit', async () => {
    for (let index = 0; index < MAX_TAGS; index += 1) {
      await addTag(USER_A, `tag-${index}`)
    }
    await expect(addTag(USER_A, 'overflow')).rejects.toMatchObject({ status: 400 })
  })
})

describe('development github gist tags', () => {
  it('deletes a gist tag tree and unbinds gists', async () => {
    await upsertGistTag(db, USER_A, {
      id: 'root',
      name: 'Root',
      color: '#64748b',
      parentId: null,
      sortOrder: 0,
    })
    await upsertGistTag(db, USER_A, {
      id: 'child',
      name: 'Child',
      color: '#64748b',
      parentId: 'root',
      sortOrder: 0,
    })
    await upsertGist(db, USER_A, gistInput('abcdef12', ['child']))

    const tags = await listGistTags(db, USER_A)
    const removed = collectDescendantTagIds(tags, 'root')
    await deleteGistTags(db, USER_A, removed)
    expect(await unbindGistTags(db, USER_A, removed)).toEqual(['abcdef12'])
    expect((await findGist(db, USER_A, 'abcdef12'))?.tagIds).toEqual([])
    expect(await listGistTags(db, USER_A)).toEqual([])
    expect(await findMissingGistTagIds(db, USER_A, ['child'])).toEqual(['child'])
  })
})

describe('development github repositories and gists', () => {
  it('isolates repositories and gists by user', async () => {
    await upsertRepo(db, USER_A, repoInput('1'))
    await upsertGist(db, USER_A, gistInput('abcdef12'))

    expect(await listRepos(db, USER_B)).toEqual([])
    expect(await listGists(db, USER_B)).toEqual([])
    expect(await findRepo(db, USER_B, '1')).toBeNull()
    expect(await findGist(db, USER_B, 'abcdef12')).toBeNull()

    expect(await deleteRepo(db, USER_B, '1')).toBe(false)
    expect(await listRepos(db, USER_A)).toHaveLength(1)
  })

  it('upserts a repository without moving its creation time', async () => {
    const created = await upsertRepo(db, USER_A, { ...repoInput('1'), createdAt: 500 })
    expect(created.createdAt).toBe(500)
    const updated = await upsertRepo(db, USER_A, {
      ...repoInput('1', ['tag']),
      pinned: true,
      createdAt: 900,
    })
    expect(updated.createdAt).toBe(500)
    expect(updated.pinned).toBe(true)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  })

  it('updates gists in bulk and deletes more ids than one chunk holds', async () => {
    await upsertGistTag(db, USER_A, {
      id: 'keep',
      name: 'Keep',
      color: '#64748b',
      parentId: null,
      sortOrder: 0,
    })
    await upsertGistTag(db, USER_A, {
      id: 'drop',
      name: 'Drop',
      color: '#64748b',
      parentId: null,
      sortOrder: 0,
    })
    for (let index = 0; index < 120; index += 1) {
      const id = index.toString(16).padStart(8, '0')
      await upsertGist(db, USER_A, gistInput(id, ['drop']))
    }

    const updated = await batchUpdateGists(db, USER_A, ['00000000', '00000001'], {
      pinned: true,
      favorited: true,
      addTagIds: ['keep'],
      removeTagIds: ['drop'],
    })
    expect(updated).toBe(2)
    const first = await findGist(db, USER_A, '00000000')
    expect(first?.pinned).toBe(true)
    expect(first?.tagIds.sort()).toEqual(['keep'])

    const ids = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(8, '0'))
    expect(await deleteGists(db, USER_A, ids)).toBe(120)
    expect(await listGists(db, USER_A)).toEqual([])
  })

  it('does not write when a batch patch names no field', async () => {
    await upsertGist(db, USER_A, gistInput('abcdef12'))
    const before = await findGist(db, USER_A, 'abcdef12')
    expect(await batchUpdateGists(db, USER_A, ['abcdef12'], {})).toBe(0)
    const after = await findGist(db, USER_A, 'abcdef12')
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })
})

describe('development github exports', () => {
  it('stores, lists and expires export records', async () => {
    await insertExport(db, USER_A, {
      id: 'export-1',
      filename: 'gist-1.md',
      format: 'md',
      r2Key: 'development/github/md/user-a/export-1.md',
      size: 10,
      createdAt: 1000,
    })
    await insertExport(db, USER_A, {
      id: 'export-2',
      filename: 'gist-2.json',
      format: 'json',
      r2Key: 'development/github/json/user-a/export-2.json',
      size: 20,
      createdAt: 2000,
    })
    expect((await listExports(db, USER_A)).map((record) => record.id)).toEqual([
      'export-2',
      'export-1',
    ])
    expect(await findExport(db, USER_B, 'export-1')).toBeNull()
    expect((await listExpiredExports(db, USER_A, 1500)).map((record) => record.id)).toEqual([
      'export-1',
    ])
    expect(await deleteExpiredExports(db, USER_A, 1500)).toBe(1)
    expect(await findExport(db, USER_A, 'export-1')).toBeNull()
  })
})
