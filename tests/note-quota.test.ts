import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { assertNoteQuota, consumeNoteQuota, openNoteQuotaBudget } from '../src/worker/db/quota'
import { makeD1 } from './doubles/d1-sqlite'

function seeded(count: number) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)`)
  for (let index = 0; index < count; index++) {
    sqlite.prepare('INSERT INTO notes VALUES (?, ?, NULL)').run(`n${index}`, 'user')
  }
  sqlite.prepare('INSERT INTO notes VALUES (?, ?, 1)').run('trashed', 'user')
  return makeD1(sqlite)
}

it('accepts a creation below the quota', async () => {
  await expect(assertNoteQuota(seeded(LIMITS.notesMaxPerUser - 1), 'user')).resolves.toBeUndefined()
})

it('rejects a creation at the quota', async () => {
  await expect(assertNoteQuota(seeded(LIMITS.notesMaxPerUser), 'user')).rejects.toThrow(/quota/i)
})

it('accounts for a batch of planned imports', async () => {
  await expect(assertNoteQuota(seeded(LIMITS.notesMaxPerUser - 2), 'user', 3)).rejects.toThrow(/quota/i)
})

it('ignores trashed notes when counting', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)`)
  for (let index = 0; index < LIMITS.notesMaxPerUser; index++) {
    sqlite.prepare('INSERT INTO notes VALUES (?, ?, 1)').run(`t${index}`, 'user')
  }
  await expect(assertNoteQuota(makeD1(sqlite), 'user')).resolves.toBeUndefined()
})

it('budgets a whole import from a single count', async () => {
  const budget = await openNoteQuotaBudget(seeded(LIMITS.notesMaxPerUser - 2), 'user')
  expect(() => {
    consumeNoteQuota(budget)
    consumeNoteQuota(budget)
  }).not.toThrow()
  expect(() => consumeNoteQuota(budget)).toThrow(/quota/i)
})

it('rejects an import that starts over the quota', async () => {
  const budget = await openNoteQuotaBudget(seeded(LIMITS.notesMaxPerUser), 'user')
  expect(() => consumeNoteQuota(budget)).toThrow(/quota/i)
})
