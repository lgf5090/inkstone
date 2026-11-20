// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_GITHUB_EXTRA_MIGRATIONS, DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import { batchUpdateRepos } from '../src/worker/development/github/store'
import {
  deleteCollectionsAtomically,
  deleteReposAtomically,
  deleteTagsAtomically,
} from '../src/worker/development/github/atomic'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
let sqlite: DatabaseSync
let db: D1Database

function insertRepo(id: string, tagIds: string[] = []): void {
  sqlite.prepare(
    'INSERT INTO development_github_repos (user_id, id, full_name, tag_ids, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
  ).run(USER, id, `owner/${id}`, JSON.stringify(tagIds))
}

function insertCollection(id: string, repoIds: string[]): void {
  sqlite.prepare(
    'INSERT INTO development_github_collections (user_id, id, name, repo_ids, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
  ).run(USER, id, id, JSON.stringify(repoIds))
}

function insertTag(id: string): void {
  sqlite.prepare(
    'INSERT INTO development_github_tags (user_id, id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 1)',
  ).run(USER, id, id, '#112233')
}

function repoIdsOf(id: string): string[] {
  const row = sqlite.prepare('SELECT repo_ids FROM development_github_collections WHERE user_id = ? AND id = ?').get(USER, id) as { repo_ids: string }
  return JSON.parse(row.repo_ids) as string[]
}

function tagIdsOf(id: string): string[] {
  const row = sqlite.prepare('SELECT tag_ids FROM development_github_repos WHERE user_id = ? AND id = ?').get(USER, id) as { tag_ids: string }
  return JSON.parse(row.tag_ids) as string[]
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  for (const statement of DEVELOPMENT_GITHUB_EXTRA_MIGRATIONS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

describe('GitHub atomic writes', () => {
  it('deletes repositories and unbinds collections in one transaction', async () => {
    insertRepo('1')
    insertRepo('2')
    insertCollection('c1', ['1', '2'])
    insertCollection('c2', ['2'])
    const result = await deleteReposAtomically(db, USER, ['1'])
    expect(result.count).toBe(1)
    expect(result.updatedIds.sort()).toEqual(['c1'])
    expect(repoIdsOf('c1')).toEqual(['2'])
    expect(repoIdsOf('c2')).toEqual(['2'])
    expect(sqlite.prepare('SELECT count(*) AS n FROM development_github_repos WHERE id = ?').get('1')).toMatchObject({ n: 0 })
  })

  it('rolls back the delete when an unbind statement fails', async () => {
    insertRepo('1')
    insertCollection('c1', ['1'])
    insertCollection('c2', ['1'])
    sqlite.exec("UPDATE development_github_collections SET repo_ids = 'not-json' WHERE id = 'c1'")
    await expect(deleteReposAtomically(db, USER, ['1'])).rejects.toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM development_github_repos WHERE id = ?').get('1')).toMatchObject({ n: 1 })
    expect(repoIdsOf('c2')).toEqual(['1'])
  })

  it('deletes tags and unbinds repositories atomically', async () => {
    insertRepo('1', ['t1', 't2'])
    insertTag('t1')
    insertTag('t2')
    const result = await deleteTagsAtomically(db, USER, ['t1'])
    expect(result.count).toBe(1)
    expect(result.updatedIds).toEqual(['1'])
    expect(tagIdsOf('1')).toEqual(['t2'])
    expect(sqlite.prepare('SELECT count(*) AS n FROM development_github_tags WHERE id = ?').get('t1')).toMatchObject({ n: 0 })
  })

  it('deletes a collection tree in one batch', async () => {
    insertCollection('parent', [])
    insertCollection('child', [])
    const count = await deleteCollectionsAtomically(db, USER, ['parent', 'child', 'parent'])
    expect(count).toBe(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM development_github_collections').get()).toMatchObject({ n: 0 })
  })

  it('applies batch flag and tag changes in one SQL statement without duplicate tags', async () => {
    insertRepo('1', ['t1', 't2'])
    const count = await batchUpdateRepos(db, USER, ['1'], {
      pinned: true,
      addTagIds: ['t2', 't3'],
      removeTagIds: ['t1'],
    })
    expect(count).toBe(1)
    expect(tagIdsOf('1').sort()).toEqual(['t2', 't3'])
    expect(sqlite.prepare('SELECT pinned FROM development_github_repos WHERE id = ?').get('1')).toMatchObject({ pinned: 1 })
  })
})
