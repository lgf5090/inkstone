// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildJsonExport } from '../src/worker/backup/snapshot'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { parseQuickAddRecord, QUICKADD_VERSION } from '../src/shared/quickadd'
import {
  buildQuickAddPayload,
  defaultQuickAddSettings,
  newCaptureChoice,
  parseQuickAddText,
} from '../src/shared/quickadd'
import { makeD1 } from './doubles/d1-sqlite'
import { newId } from '../src/worker/lib/id'

const USER = 'user-1'
const NOTE_ID = newId()

let sqlite: DatabaseSync
let env: { DB: D1Database }

/** The envelope `PUT /api/quickadd/library` writes: the transport payload, normalized, then wrapped. */
function storedEnvelope(): string {
  const settings = {
    ...defaultQuickAddSettings(),
    dateFormat: 'MM/DD/YYYY',
    defaultFolder: 'Automation',
    globalVars: [{ name: 'sign-off', value: 'ends here' }],
    periodic: {
      ...defaultQuickAddSettings().periodic,
      daily: { folder: 'Logs', format: 'YYYY-MM-DD [Daily]', templateId: null },
    },
  }
  const payload = buildQuickAddPayload(settings, [newCaptureChoice('c1', 'Quick capture', 0)])
  const library = parseQuickAddText(JSON.stringify(payload)).data
  return JSON.stringify({ savedAt: 5, version: QUICKADD_VERSION, library })
}

function seedColumn(value: string | null) {
  sqlite.prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2').run(value, USER)
}

async function exported(): Promise<Record<string, any>> {
  const bytes = await buildJsonExport(env as never, USER)
  return JSON.parse(new TextDecoder().decode(bytes))
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'one', 'h', 'one', 'One', '', 'member', '{}', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count, content_hash, created_at, updated_at)
     VALUES (?1, ?2, 'Hello', 'hello', '# Hello', 'Hello', 1, 1, 7, 'h', 1, 1)`,
  ).run(NOTE_ID, USER)
  env = { DB: makeD1(sqlite) }
})

describe('the automation library inside a JSON export', () => {
  it('carries the choices, the settings and the periodic note the account names', async () => {
    seedColumn(storedEnvelope())
    const bundle = await exported()
    expect(bundle.quickadd.choices.map((choice: { name: string }) => choice.name)).toEqual(['Quick capture'])
    expect(bundle.quickadd.settings.dateFormat).toBe('MM/DD/YYYY')
    expect(bundle.quickadd.settings.defaultFolder).toBe('Automation')
    expect(bundle.quickadd.settings.periodic.daily.folder).toBe('Logs')
    expect(bundle.quickadd.settings.globalVars).toEqual([{ name: 'sign-off', value: 'ends here' }])
  })

  it('stays inside the same rules an upload is held to', async () => {
    seedColumn(storedEnvelope())
    const bundle = await exported()
    const parsed = parseQuickAddRecord(bundle.quickadd)
    expect([parsed.dropped, parsed.truncated]).toEqual([0, false])
    expect(parsed.data?.choices).toHaveLength(1)
    expect(parsed.data?.settings.periodic.daily.format).toBe('YYYY-MM-DD [Daily]')
  })

  it('leaves the section out for an account that has never saved a library', async () => {
    seedColumn(null)
    const bundle = await exported()
    expect(bundle.quickadd).toBeUndefined()
    expect(bundle.notes).toHaveLength(1)
  })

  it('exports the notes of an account whose stored library has gone to junk', async () => {
    seedColumn('not json at all')
    const broken = await exported()
    expect(broken.quickadd).toBeUndefined()
    expect(broken.notes).toHaveLength(1)

    seedColumn('{"savedAt": 5, "library": {"choices": "no array here"}}')
    const empty = await exported()
    expect(empty.quickadd).toBeUndefined()
    expect(empty.notes).toHaveLength(1)
  })
})
