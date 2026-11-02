// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { D1_BATCH_CHUNK, chunkedBatch, queryExternalEntries } from '../src/worker/clouddrive/lib'
import type { CloudDriveEntry } from '../src/shared/clouddrive/model'

function statementRecorder() {
  const sizes: number[] = []
  const seen: D1PreparedStatement[][] = []
  const db = {
    batch: async (statements: D1PreparedStatement[]) => {
      sizes.push(statements.length)
      seen.push(statements)
      return []
    },
  }
  return { sizes, seen, db: db as unknown as D1Database }
}

describe('clouddrive D1 batch chunking', () => {
  it('splits a long statement list into batches of at most D1_BATCH_CHUNK', async () => {
    const { sizes, seen, db } = statementRecorder()
    const statements = Array.from({ length: D1_BATCH_CHUNK * 2 + 25 }, () => ({} as D1PreparedStatement))

    await chunkedBatch(db, statements)

    expect(sizes).toEqual([D1_BATCH_CHUNK, D1_BATCH_CHUNK, 25])
    expect(seen.flat()).toHaveLength(statements.length)
    expect(seen.flat()).toEqual(statements)
  })

  it('does not open a batch for an empty list', async () => {
    const { sizes, db } = statementRecorder()
    await chunkedBatch(db, [])
    expect(sizes).toEqual([])
  })
})

function entry(overrides: Partial<CloudDriveEntry> & { name: string }): CloudDriveEntry {
  return {
    id: overrides.name,
    kind: 'file',
    path: `/${overrides.name}`,
    mountId: 's3',
    mountName: 'Bucket',
    category: 'other',
    mime: 'application/octet-stream',
    size: 10,
    uploadedAt: 1_000,
    modifiedAt: 1_000,
    starredAt: null,
    readOnly: false,
    hasThumbnail: false,
    storage: 's3',
    storageKind: 'external',
    color: null,
    tags: [],
    ...overrides,
  }
}

const LISTING = [
  entry({ name: 'README.md', category: 'documents', size: 30, modifiedAt: 500 }),
  entry({ name: 'readme.txt', category: 'txt', size: 10, uploadedAt: 2_000 }),
  entry({ name: 'Photo.JPG', category: 'images', size: 20, modifiedAt: 100 }),
]

describe('clouddrive external listing query', () => {
  it('matches the name case-insensitively, which the driver order never guarantees', () => {
    const found = queryExternalEntries(LISTING, { q: 'README', sort: 'name', dir: 'asc' })
    expect(found.map((item) => item.name)).toEqual(['README.md', 'readme.txt'])
  })

  it('keeps only the requested category', () => {
    const found = queryExternalEntries(LISTING, { type: 'images', sort: 'name', dir: 'asc' })
    expect(found.map((item) => item.name)).toEqual(['Photo.JPG'])
  })

  it('ignores a category the model does not have instead of emptying the folder', () => {
    const found = queryExternalEntries(LISTING, { type: 'not-a-category', sort: 'name', dir: 'asc' })
    expect(found).toHaveLength(LISTING.length)
  })

  it('sorts by the chosen column and reverses with the direction', () => {
    const bySize = queryExternalEntries(LISTING, { sort: 'size', dir: 'asc' })
    expect(bySize.map((item) => item.size)).toEqual([10, 20, 30])
    const newest = queryExternalEntries(LISTING, { sort: 'modified', dir: 'desc' })
    expect(newest.map((item) => item.name)).toEqual(['readme.txt', 'README.md', 'Photo.JPG'])
  })

  it('breaks ties by the folded name so the order does not depend on the driver', () => {
    const tied = [entry({ name: 'b.txt', size: 1 }), entry({ name: 'a.txt', size: 1 })]
    const sorted = queryExternalEntries(tied, { sort: 'size', dir: 'asc' })
    expect(sorted.map((item) => item.name)).toEqual(['a.txt', 'b.txt'])
  })
})
