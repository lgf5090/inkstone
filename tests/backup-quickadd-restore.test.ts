// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyBackupQuickAdd } from '../src/worker/backup/quickadd'
import { quickAddLibraryFromStored } from '../src/shared/quickadd'
import {
  buildQuickAddPayload,
  defaultQuickAddSettings,
  newCaptureChoice,
  QUICKADD_LIMITS,
} from '../src/shared/quickadd'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const OTHER = 'user-2'

let sqlite: DatabaseSync
let db: D1Database

function stored(): string | null {
  const row = sqlite.prepare('SELECT quickadd FROM users WHERE id = ?').get(USER) as { quickadd: string | null } | undefined
  return row?.quickadd ?? null
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (const id of [USER, OTHER]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'h', ?, 'One', '', 'member', '{}', 1, 1)`,
    ).run(id, `name-${id}`, `name-${id}`)
  }
  db = makeD1(sqlite)
})

describe('restoring the automation library from an export', () => {
  it('writes the same envelope the live library endpoint writes', async () => {
    const settings = { ...defaultQuickAddSettings(), dateFormat: 'MM/DD/YYYY' }
    const payload = buildQuickAddPayload(settings, [newCaptureChoice('c1', 'Quick capture', 0)])
    await expect(applyBackupQuickAdd(db, USER, payload)).resolves.toEqual({ choices: 1 })
    const library = quickAddLibraryFromStored(stored())
    expect(library?.choices.map((choice) => choice.name)).toEqual(['Quick capture'])
    expect(library?.settings.dateFormat).toBe('MM/DD/YYYY')
  })

  it('refuses a library it cannot read', async () => {
    await expect(applyBackupQuickAdd(db, USER, 'not json at all')).rejects.toThrow(/QuickAdd library/i)
    await expect(applyBackupQuickAdd(db, USER, { app: 'other', settings: {} })).rejects.toThrow(/QuickAdd library/i)
    expect(stored()).toBeNull()
  })

  it('refuses a library that would lose entries on the way in', async () => {
    const tooMany = Array.from({ length: QUICKADD_LIMITS.maxChoices + 1 }, (_, index) =>
      newCaptureChoice(`c${index}`, `Capture ${index}`, index))
    const payload = buildQuickAddPayload(defaultQuickAddSettings(), tooMany)
    await expect(applyBackupQuickAdd(db, USER, payload)).rejects.toThrow(/drop|discard/i)
    expect(stored()).toBeNull()
  })

  it('leaves another account’s library alone', async () => {
    const payload = buildQuickAddPayload(defaultQuickAddSettings(), [newCaptureChoice('c1', 'Quick capture', 0)])
    await applyBackupQuickAdd(db, USER, payload)
    await expect(applyBackupQuickAdd(db, 'user-gone', payload)).rejects.toThrow(/account/i)
    const library = quickAddLibraryFromStored(stored())
    expect(library?.choices).toHaveLength(1)
    expect(sqlite.prepare('SELECT quickadd FROM users WHERE id = ?').get(OTHER)).toMatchObject({ quickadd: null })
  })
})
