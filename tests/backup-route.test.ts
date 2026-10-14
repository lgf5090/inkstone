// @vitest-environment node
// Behavioural coverage for `src/worker/routes/backup.ts` (its seven D1 statements now live in
// `src/worker/backup/store.ts`; the claims here are about what the routes answer, not about which
// file holds the SQL). The vault double below is only a stand-in for the encryption service so the
// create/update paths are reachable at all: it stores what it was handed under an opaque handle, and
// the assertions never look at a credential value — they look at `hasSecret` and at the row counts,
// statuses and messages the route owns.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { backupRoutes } from '../src/worker/routes/backup'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

/** The credential vault's `/encrypt` + `/decrypt` protocol, kept in a map instead of AES-GCM. */
const vaultEntries = new Map<string, unknown>()
let vaultSerial = 0
const vault = {
  idFromName: () => 'vault-id',
  get: () => ({
    async fetch(url: string, init: { body?: unknown }): Promise<Response> {
      const request = JSON.parse(String(init.body)) as { value?: unknown; ciphertext?: string }
      if (url.endsWith('/encrypt')) {
        const ciphertext = `v1.${++vaultSerial}`
        vaultEntries.set(ciphertext, request.value)
        return Response.json({ ciphertext })
      }
      if (url.endsWith('/decrypt')) {
        if (!request.ciphertext || !vaultEntries.has(request.ciphertext)) {
          return Response.json({}, { status: 422 })
        }
        return Response.json({ value: vaultEntries.get(request.ciphertext) })
      }
      return Response.json({}, { status: 404 })
    },
  }),
}

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/backup', backupRoutes)

function env() {
  return { DB: db, CREDENTIAL_VAULT: vault } as unknown as AppBindings['Bindings']
}

async function send(method: string, path: string, body?: unknown, userId = ALICE) {
  mocks.userId = userId
  return app.request(`/api/backup${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env())
}

function webdav(name = 'Home server') {
  return {
    type: 'webdav' as const,
    name,
    enabled: true,
    config: { url: 'https://dav.example.com/backup', username: 'reader' },
    secret: { password: 'a-secret-nobody-asserts-on' },
  }
}

function insertTarget(id: string, userId: string, createdAt: number, overrides: { name?: string; secret?: string | null; updatedAt?: number } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO backup_targets (id, user_id, type, name, enabled, config, secret, created_at, updated_at)
       VALUES (?, ?, 'webdav', ?, 1, '{"url":"https://dav.example.com/backup","username":"reader"}', ?, ?, ?)`,
    )
    .run(id, userId, overrides.name ?? `Target ${id}`, overrides.secret ?? null, createdAt, overrides.updatedAt ?? createdAt)
}

function insertArchive(targetId: string, userId: string, path: string): void {
  sqlite
    .prepare('INSERT INTO backup_archives (user_id, target_id, destination, archive_path, created_at) VALUES (?,?,?,?,?)')
    .run(userId, targetId, 'https://dav.example.com/backup', path, 1)
}

function insertRun(id: string, userId: string, startedAt: number, detail = '[]'): void {
  sqlite
    .prepare(
      `INSERT INTO backup_runs (id, user_id, trigger, status, started_at, finished_at, note_count, file_count, bytes, detail)
       VALUES (?, ?, 'manual', 'success', ?, ?, 3, 1, 4096, ?)`,
    )
    .run(id, userId, startedAt, startedAt + 10, detail)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  vaultEntries.clear()
  vaultSerial = 0
})

describe('listing and creating targets', () => {
  it('answers the account’s own targets oldest first', async () => {
    insertTarget('t-old', ALICE, 100)
    insertTarget('t-new', ALICE, 200)
    insertTarget('t-bob', BOB, 150)
    const body = await (await send('GET', '/targets')).json() as { targets: { id: string }[] }
    expect(body.targets.map((one) => one.id)).toEqual(['t-old', 't-new'])
  })

  it('creates a target and reports it back with 201', async () => {
    const response = await send('POST', '/targets', webdav())
    expect(response.status).toBe(201)
    const created = await response.json() as { id: string; name: string; hasSecret: boolean; type: string }
    expect(created.name).toBe('Home server')
    expect(created.type).toBe('webdav')
    expect(created.hasSecret).toBe(true)
    const row = sqlite.prepare('SELECT user_id, secret FROM backup_targets WHERE id = ?').get(created.id) as { user_id: string; secret: string }
    expect(row.user_id).toBe(ALICE)
    // The stored text is the vault handle, never the credential the request carried.
    expect(row.secret).not.toContain('a-secret-nobody-asserts-on')
  })

  it('refuses a webdav target without a password', async () => {
    const body = webdav()
    delete (body as { secret?: unknown }).secret
    const response = await send('POST', '/targets', body)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toBe('Enter a password')
  })

  it('holds the per-account ceiling inside the insert', async () => {
    for (let index = 0; index < LIMITS.backupTargetsMax; index++) insertTarget(`t-${index}`, ALICE, index + 1)
    const response = await send('POST', '/targets', webdav('One too many'))
    expect(response.status).toBe(409)
    expect((await response.json() as { error: { message: string } }).error.message).toBe(
      `Each account can configure at most ${LIMITS.backupTargetsMax} backup targets`,
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_targets WHERE user_id = ?').get(ALICE)).toEqual({ n: LIMITS.backupTargetsMax })
    // A second account is nowhere near the first account's ceiling.
    expect((await send('POST', '/targets', webdav('Bobby'), BOB)).status).toBe(201)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_targets WHERE user_id = ?').get(BOB)).toEqual({ n: 1 })
  })
})

describe('changing a target', () => {
  it('renames it and refuses a stale expectedUpdatedAt', async () => {
    insertTarget('t-1', ALICE, 100, { updatedAt: 500 })
    const renamed = await send('PATCH', '/targets/t-1', { name: 'Renamed', expectedUpdatedAt: 500 })
    expect(renamed.status).toBe(200)
    expect((await renamed.json() as { name: string; updatedAt: number }).name).toBe('Renamed')

    const stale = await send('PATCH', '/targets/t-1', { name: 'Too late', expectedUpdatedAt: 500 })
    expect(stale.status).toBe(409)
    expect((await stale.json() as { error: { message: string } }).error.message).toBe(
      'The backup target changed elsewhere. Refresh and try again',
    )
    expect((sqlite.prepare('SELECT name FROM backup_targets WHERE id = ?').get('t-1') as { name: string }).name).toBe('Renamed')
  })

  it('answers 404 for a target belonging to another account', async () => {
    insertTarget('t-bob', BOB, 100, { updatedAt: 500 })
    expect((await send('PATCH', '/targets/t-bob', { name: 'Not yours', expectedUpdatedAt: 500 })).status).toBe(404)
    expect((await send('DELETE', '/targets/t-bob')).status).toBe(404)
    expect((sqlite.prepare('SELECT name FROM backup_targets WHERE id = ?').get('t-bob') as { name: string }).name).toBe('Target t-bob')
  })
})

describe('deleting a target', () => {
  it('takes its archive rows with it, in one batch', async () => {
    insertTarget('t-1', ALICE, 100)
    insertTarget('t-bob', BOB, 100)
    insertArchive('t-1', ALICE, 'inkstone-1.zip')
    insertArchive('t-1', ALICE, 'inkstone-2.zip')
    insertArchive('t-bob', BOB, 'other.zip')

    expect((await send('DELETE', '/targets/t-1')).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_targets WHERE id = ?').get('t-1')).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_archives WHERE target_id = ?').get('t-1')).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_archives WHERE target_id = ?').get('t-bob')).toEqual({ n: 1 })
    // Stopping is idempotent for the client, and the second press says what the first one means.
    expect((await send('DELETE', '/targets/t-1')).status).toBe(404)
  })
})

describe('the run history', () => {
  it('lists this account’s runs newest first with parsed per-target results', async () => {
    insertRun('r-1', ALICE, 100, JSON.stringify([{ targetId: 't-1', ok: true }]))
    insertRun('r-2', ALICE, 300)
    insertRun('r-bob', BOB, 200)
    const body = await (await send('GET', '/runs')).json() as { runs: { id: string; startedAt: number; results: unknown[] }[] }
    expect(body.runs.map((run) => run.id)).toEqual(['r-2', 'r-1'])
    expect(body.runs[1].results).toEqual([{ targetId: 't-1', ok: true }])
    expect(body.runs[0].results).toEqual([])
    expect(body.runs[0]).toMatchObject({ noteCount: 3, fileCount: 1, bytes: 4096, status: 'success', trigger: 'manual' })
  })

  it('caps the history at the window the card shows', async () => {
    for (let index = 0; index < 60; index++) insertRun(`r-${index}`, ALICE, index + 1)
    const body = await (await send('GET', '/runs')).json() as { runs: { id: string }[] }
    expect(body.runs).toHaveLength(50)
    expect(body.runs[0].id).toBe('r-59')
  })
})

describe('a fresh install', () => {
  it('answers empty collections rather than errors', async () => {
    expect((await send('GET', '/targets')).status).toBe(200)
    expect((await (await send('GET', '/targets')).json() as { targets: unknown[] }).targets).toEqual([])
    expect((await (await send('GET', '/runs')).json() as { runs: unknown[] }).runs).toEqual([])
  })
})
