// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertExportStorage,
  buildGistExport,
  cleanupExpiredExports,
  EXPORT_CONTENT_TYPES,
  exportKey,
  gistExportFilename,
  putGistExport,
  readExportObject,
} from '../src/worker/development/github/r2'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import { findExport, insertExport, listExports } from '../src/worker/development/github/store'
import { EXPORT_TTL_MS, MAX_EXPORT_BYTES } from '../src/shared/development/github/limits'
import type { GithubTag, SavedGist } from '../src/shared/development/github/types'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'
import type { TestR2Bucket } from './doubles/bindings'

const USER_A = 'user-a'
const USER_B = 'user-b'
const GIST_ID = 'abcdef12'

let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env

function gist(): SavedGist {
  return {
    id: GIST_ID,
    description: 'A sample gist',
    url: 'https://gist.github.com/abcdef12',
    data: {
      id: GIST_ID,
      description: 'A sample gist',
      url: 'https://gist.github.com/abcdef12',
      isPublic: true,
      owner: { login: 'octocat', avatarUrl: '' },
      files: [
        {
          filename: 'example.ts',
          language: 'TypeScript',
          content: 'const fence = ```\nconsole.log("hi")\n',
          size: 38,
        },
        {
          filename: 'readme.md',
          language: 'Markdown',
          content: '# Hello',
          size: 7,
        },
      ],
      fileCount: 2,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    },
    tagIds: ['tag-1', 'missing'],
    pinned: false,
    favorited: true,
    notes: 'Remember this',
    createdAt: 1000,
    updatedAt: 2000,
  }
}

function tag(): GithubTag {
  return {
    id: 'tag-1',
    name: 'Samples',
    color: '#112233',
    parentId: null,
    sortOrder: 0,
    createdAt: 500,
    updatedAt: 500,
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, { FILES: bucket })
})

afterEach(() => {
  sqlite.close()
  vi.restoreAllMocks()
})

describe('development github export content', () => {
  it('serializes json with the export envelope and only matching tags', () => {
    const content = buildGistExport('json', { gist: gist(), tags: [tag()] }, 1234567890)
    const parsed = JSON.parse(content) as {
      version: number
      exportedAt: string
      gist: Record<string, unknown> & { tags: unknown[]; files: unknown[] }
    }
    expect(parsed.version).toBe(1)
    expect(parsed.exportedAt).toBe(new Date(1234567890).toISOString())
    expect(parsed.gist.id).toBe(GIST_ID)
    expect(parsed.gist.notes).toBe('Remember this')
    expect(parsed.gist.files).toHaveLength(2)
    expect(parsed.gist.tags).toEqual([
      { id: 'tag-1', name: 'Samples', color: '#112233', parentId: null },
    ])
    expect(content).toContain('\n  "version": 1')
  })

  it('marks markdown fences longer than any backtick run in the file', () => {
    const content = buildGistExport('md', { gist: gist(), tags: [] })
    expect(content.startsWith('# A sample gist\n')).toBe(true)
    expect(content).toContain('## example.ts')
    expect(content).toContain('````TypeScript')
    expect(content).toContain('````')
    expect(content).toContain('## readme.md')
  })

  it('writes a plain text header per file', () => {
    const content = buildGistExport('txt', { gist: gist(), tags: [] })
    expect(content).toContain('===== example.ts (TypeScript, 38 bytes) =====')
    expect(content).toContain('===== readme.md (Markdown, 7 bytes) =====')
    expect(content).toContain('# Hello')
  })

  it('builds format-specific keys and filenames', () => {
    expect(exportKey('md', USER_A, 'export-1')).toBe('development/github/md/user-a/export-1.md')
    expect(exportKey('json', USER_A, 'export-1')).toBe('development/github/json/user-a/export-1.json')
    expect(exportKey('txt', USER_A, 'export-1')).toBe('development/github/txt/user-a/export-1.txt')
    expect(gistExportFilename(GIST_ID, 'txt')).toBe('gist-abcdef12.txt')
    expect(EXPORT_CONTENT_TYPES.json).toBe('application/json; charset=utf-8')
  })
})

describe('development github export storage', () => {
  it('puts an object with its content type and reads it back', async () => {
    const written = await putGistExport(env, {
      userId: USER_A,
      exportId: 'export-1',
      format: 'md',
      content: '# Hello',
    })
    expect(written).toEqual({
      key: 'development/github/md/user-a/export-1.md',
      size: 7,
    })
    expect(bucket.objects.get(written.key)).toBeInstanceOf(Uint8Array)
    expect(bucket.types.get(written.key)).toBe('text/markdown; charset=utf-8')
    const object = await readExportObject(env, written.key)
    expect(await object.text()).toBe('# Hello')
  })

  it('refuses exports larger than the ceiling', async () => {
    await expect(
      putGistExport(env, {
        userId: USER_A,
        exportId: 'export-1',
        format: 'txt',
        content: 'x'.repeat(MAX_EXPORT_BYTES + 1),
      }),
    ).rejects.toMatchObject({ status: 413 })
    expect(bucket.objects.size).toBe(0)
  })

  it('reports missing storage as unavailable', async () => {
    const missing = testBindings(db)
    let caught: unknown
    try {
      assertExportStorage(missing)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ status: 503, code: 'storage_unavailable' })
    await expect(
      putGistExport(missing, {
        userId: USER_A,
        exportId: 'export-1',
        format: 'json',
        content: '{}',
      }),
    ).rejects.toMatchObject({ status: 503, code: 'storage_unavailable' })
  })

  it('cleans expired records and their objects after the TTL', async () => {
    const now = Date.now()
    const expiredCreatedAt = now - EXPORT_TTL_MS - 1000
    await bucket.put('development/github/json/user-a/export-old.json', '{}')
    await insertExport(db, USER_A, {
      id: 'export-old',
      filename: 'gist-old.json',
      format: 'json',
      r2Key: 'development/github/json/user-a/export-old.json',
      size: 2,
      createdAt: expiredCreatedAt,
    })
    await insertExport(db, USER_B, {
      id: 'export-other',
      filename: 'gist-other.json',
      format: 'json',
      r2Key: 'development/github/json/user-b/export-other.json',
      size: 2,
      createdAt: expiredCreatedAt,
    })
    await cleanupExpiredExports(env, db, USER_A)
    expect(bucket.objects.has('development/github/json/user-a/export-old.json')).toBe(false)
    expect(await findExport(db, USER_A, 'export-old')).toBeNull()
    expect(await findExport(db, USER_B, 'export-other')).not.toBeNull()
  })

  it('still removes the record when the object delete fails', async () => {
    const now = Date.now()
    await insertExport(db, USER_A, {
      id: 'export-old',
      filename: 'gist-old.json',
      format: 'json',
      r2Key: 'development/github/json/user-a/export-old.json',
      size: 2,
      createdAt: now - EXPORT_TTL_MS - 1000,
    })
    bucket.delete = async () => {
      throw new Error('r2 unavailable')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cleanupExpiredExports(env, db, USER_A)
    expect(await listExports(db, USER_A)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})
