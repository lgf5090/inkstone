// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubAttachmentSort } from '../src/shared/attachment-hub'
import { listHubAttachments } from '../src/worker/attachments/hub-rows'
import * as references from '../src/worker/attachments/references'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'
const QUOTA_BYTES = 1_000_000

function id(value: number): string {
  return String(value).padStart(26, '0')
}

const ROWS = [
  { id: 1, filename: 'alpha.txt', size: 20, createdAt: 300 },
  { id: 2, filename: 'ALPHA.txt', size: 20, createdAt: 100 },
  { id: 3, filename: 'beta.txt', size: 10, createdAt: 200 },
  { id: 4, filename: 'beta.txt', size: 30, createdAt: 100 },
  { id: 5, filename: 'Gamma.txt', size: 10, createdAt: 200 },
  { id: 6, filename: 'gamma.txt', size: 40, createdAt: 300 },
]

const TRAVERSALS: Array<[HubAttachmentSort, number[]]> = [
  ['date_desc', [6, 1, 5, 3, 4, 2]],
  ['date_asc', [2, 4, 3, 5, 1, 6]],
  ['name_asc', [1, 2, 3, 4, 5, 6]],
  ['name_desc', [6, 5, 4, 3, 2, 1]],
  ['size_desc', [6, 4, 2, 1, 5, 3]],
  ['size_asc', [3, 5, 1, 2, 4, 6]],
]

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  const insert = sqlite.prepare(
    `INSERT INTO attachments
       (id, user_id, scope, filename, mime, size, sha256, storage, created_at)
     VALUES (?, ?, 'notes', ?, 'text/plain', ?, ?, 'r2', ?)`,
  )
  for (const row of ROWS) {
    insert.run(id(row.id), USER, row.filename, row.size, `${id(row.id)}hash`, row.createdAt)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

describe('attachment hub keyset pagination', () => {
  it.each(TRAVERSALS)('traverses %s once per row across tied sort keys', async (sort, expected) => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const result = await listHubAttachments(db, USER, 'notes', { sort, limit: 2, cursor }, QUOTA_BYTES)
      seen.push(...result.files.map((file) => file.id))
      cursor = result.nextCursor ?? undefined
      pages += 1
      expect(pages).toBeLessThanOrEqual(4)
    } while (cursor)

    expect(seen).toEqual(expected.map(id))
    expect(new Set(seen).size).toBe(ROWS.length)
  })

  it('rejects a cursor created for another sort instead of traversing with the wrong key', async () => {
    const first = await listHubAttachments(db, USER, 'notes', { sort: 'name_asc', limit: 2 }, QUOTA_BYTES)

    await expect(listHubAttachments(db, USER, 'notes', {
      sort: 'size_asc',
      limit: 2,
      cursor: first.nextCursor!,
    }, QUOTA_BYTES)).rejects.toMatchObject({
      status: 400,
      message: 'The cursor does not match the sort',
    })
  })

  it('returns global stats and the global reference scan only for the first page', async () => {
    sqlite.prepare(
      `INSERT INTO notes
         (id, user_id, title, content, created_at, updated_at)
       VALUES (?, ?, 'Referenced', ?, 1, 1)`,
    ).run(id(100), USER, `![](/api/files/${id(3)})`)
    const scan = vi.spyOn(references, 'collectAttachmentReferences')

    const first = await listHubAttachments(db, USER, 'notes', { sort: 'date_desc', limit: 2 }, QUOTA_BYTES)
    expect(first.stats).toMatchObject({ totalCount: ROWS.length, unreferencedCount: ROWS.length - 1 })
    expect(scan.mock.calls.map((call) => call[2])).toEqual([
      new Set([id(6), id(1)]),
      undefined,
    ])

    scan.mockClear()
    const second = await listHubAttachments(db, USER, 'notes', {
      sort: 'date_desc',
      limit: 2,
      cursor: first.nextCursor!,
    }, QUOTA_BYTES)

    expect('stats' in second).toBe(false)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan.mock.calls[0]?.[2]).toEqual(new Set([id(5), id(3)]))
    expect(second.files.find((file) => file.id === id(3))?.references).toBe(1)
  })
})
