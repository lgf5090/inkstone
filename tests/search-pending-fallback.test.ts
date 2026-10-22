// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { SearchStore } from '../src/worker/search/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The half of a search that has to work before the FTS drain lands.
 *
 * Every write queues a row and the index catches up on a timer, so anything a reader saved seconds
 * ago is only findable through the LIKE fallback over the pending queue. That queue is longer than
 * what a reader can have just written — a bulk import queues a whole notebook at once — so which
 * pending rows the fallback looks at is the difference between "my import is searchable" and "it is
 * invisible until the drain happens to run".
 */

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let store: SearchStore
let otherStore: SearchStore

function note(id: string, user: string, title: string, content: string): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, '', 1, 0, 0, 0, 0, 0, 0, '', 1, 1, NULL)`,
  ).run(id, user, title, title.toLowerCase(), content)
}

function queue(id: string, user: string, createdAt: number): void {
  sqlite.prepare(
    `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at) VALUES (?, ?, 'upsert', ?)`,
  ).run(user, id, createdAt)
}

/** `count` notes queued in ascending write order, oldest first, numbered from `firstAt`. */
function queueHistory(prefix: string, count: number, firstAt: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const id = `${prefix}${index}`
    note(id, MINE, `Bulk Note ${index}`, `bulk body ${index}`)
    queue(id, MINE, firstAt + index)
    ids.push(id)
  }
  return ids
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const db = makeD1(sqlite)
  store = new SearchStore(db, MINE)
  otherStore = new SearchStore(db, OTHER)
})

describe('the pending half of a search', () => {
  it('starts from the newest queued write, not from wherever the scan began', async () => {
    const oldest = queueHistory('n-', LIMITS.searchLimit + 5, 1)
    const newest = oldest[oldest.length - 1]!

    const pending = await store.pendingFtsNoteIds()

    expect(pending).toHaveLength(LIMITS.searchLimit)
    expect(pending[0]).toBe(newest)
    expect(pending).toContain(`n-${LIMITS.searchLimit - 1}`)
    expect(pending).not.toContain(oldest[0]!)
  })

  it('reads only the account it was built for', async () => {
    queueHistory('mine-', 3, 1)
    note('theirs', OTHER, 'Their Note', 'their body')
    queue('theirs', OTHER, 9_999)

    expect(await store.pendingFtsNoteIds()).toEqual(['mine-2', 'mine-1', 'mine-0'])
    expect(await otherStore.pendingFtsNoteIds()).toEqual(['theirs'])
  })

  it('answers empty for an account with nothing queued', async () => {
    expect(await store.pendingFtsNoteIds()).toEqual([])
  })
})
