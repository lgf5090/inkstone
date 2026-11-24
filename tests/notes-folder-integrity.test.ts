// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { NotesStore } from '../src/worker/notes/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const FOLDER = 'f'.repeat(26)
const NOTE = 'n'.repeat(26)

function store(): { store: NotesStore; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  return { store: new NotesStore(makeD1(sqlite), USER, false), sqlite }
}

describe('note folder integrity', () => {
  it('refuses to create a note in a folder that no longer exists', async () => {
    const { store: notes, sqlite } = store()
    const result = await notes.create({
      id: NOTE,
      folderId: FOLDER,
      title: 'Orphan',
      content: 'body',
      excerpt: 'body',
      words: 1,
      chars: 4,
      isStarred: false,
      contentHash: 'hash',
      now: 1,
    })

    expect(result.created).toBe(false)
    expect(result.row).toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get()).toMatchObject({ n: 0 })
  })
})
