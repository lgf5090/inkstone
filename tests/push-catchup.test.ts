// @vitest-environment node
/**
 * The cron's half of Web Push: say again what no fan-out got said, and do it once.
 *
 * The immediate path (see `tests/push-fanout.test.ts`) is the delivery path; this fire exists for the two
 * ways it does not happen — every device refused, or the process died between writing the row and handing
 * the sends to `waitUntil`. What a repeated fire must never do is announce the same notification again, so
 * these tests are mostly about one judgement: `pushed_at IS NULL` means "no device ever accepted a nudge for
 * this row", and nothing else in the database says that.
 *
 * The shape behind the judgement is tested too: a column the migration ledger may have been told about
 * without the database ever getting it is the failure this repo has already been bitten by once, and a cron
 * that runs three times an hour reads a table that never shrinks, so its index has to be the partial one.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { PUSH_CATCHUP_WINDOW_MS, newPushFanoutTally, runPushCatchUp } from '../src/worker/assistant/push-fanout'
import worker from '../src/worker/index'
import type { Env } from '../src/worker/env'
import { fromUtf8, toBase64Url } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const PHONE = 'https://web.push.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3De'
const OTHER_LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx9999tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kZZZZ'
const P256DH = 'BKwRvYJ0mMVaDBHn8lPMZ3wqZ3xq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3nPo'
const AUTH = '7Q9rUxF7Vh1sQ7Q9rUxF'
/** A notification id, used only to prove a nudge does not carry one. */
const NOTE_ID = '0123456789abcdefghjkmn0001'

let sqlite: DatabaseSync
let env: Env
let vapid: { publicKey: string, privateKey: string }
let subscriptionReads: string[]
let baseD1: D1Database

function envWith(overrides: Partial<Env> = {}): Env {
  const counted: D1Database = {
    prepare(query: string) {
      if (/^\s*SELECT[\s\S]*\bchat_push_subscriptions\b/i.test(query)) subscriptionReads.push(query)
      return baseD1.prepare(query)
    },
    batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return baseD1.batch<T>(statements)
    },
    exec: (query: string) => baseD1.exec(query),
    withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) => baseD1.withSession(constraint),
    dump: () => baseD1.dump(),
  }
  return testBindings(counted, {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    PUBLIC_URL: 'http://localhost',
    ...overrides,
  })
}

function storeFor(userId: string): AssistantStore {
  return new AssistantStore(env.DB, userId, env)
}

/**
 * A notification as the sweep would have left it.
 *
 * Written straight into the table because the thing under test is the fire that reads it back, and the row
 * being un-announced is the starting condition rather than something to exercise again here.
 */
function insertNotification(userId: string, id: string, title: string, at = Date.now()): void {
  sqlite.prepare(
    `INSERT INTO chat_notifications (user_id, id, title, body, automation_id, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
  ).run(userId, id, title, title, at)
}

async function subscribe(userId: string, endpoint: string): Promise<void> {
  await storeFor(userId).upsertPushSubscription({ endpoint, p256dh: P256DH, auth: AUTH })
}

function pushedAt(userId: string, id: string): number | null {
  const row = sqlite.prepare(`SELECT pushed_at FROM chat_notifications WHERE user_id = ?1 AND id = ?2`)
    .get(userId, id) as { pushed_at: number | null } | undefined
  return row?.pushed_at ?? null
}

function stubFetch(respond: (url: string, index: number) => Response): { bodies: string[], urls: string[] } {
  // Installing the fake service is where the measured work begins: the fixture's own subscription writes go
  // through the store and read the table back, and those are setup, not a fire.
  subscriptionReads.length = 0
  const bodies: string[] = []
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    const body = init?.body
    bodies.push(typeof body === 'string' ? body : body instanceof Uint8Array ? fromUtf8(body) : '')
    return respond(url, urls.length - 1)
  }))
  return { bodies, urls }
}

const ok = () => new Response(null, { status: 201 })

/** A cron fire at a minute this deployment's pattern actually produces. */
async function fireCron(minute: number): Promise<void> {
  const at = new Date('2026-10-18T12:00:00.000Z')
  at.setUTCMinutes(minute)
  const tasks: Promise<unknown>[] = []
  const ctx = { waitUntil: (task: Promise<unknown>) => { tasks.push(task) } } as ExecutionContext
  const event = { scheduledTime: at.getTime(), cron: '0,15,45 * * * *' } as ScheduledController
  await worker.scheduled(event, env, ctx)
  // `scheduled()` hands everything to `waitUntil` and returns immediately, so the fire's work is the tasks.
  await Promise.all(tasks)
}

beforeEach(async () => {
  subscriptionReads = []
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  baseD1 = makeD1(sqlite)
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  vapid = {
    publicKey: toBase64Url(new Uint8Array(raw)),
    privateKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }),
  }
  env = envWith()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the catch-up fire', () => {
  it('announces a row no fan-out ever got to, and stamps it', async () => {
    insertNotification(USER, NOTE_ID, 'The morning digest ran out of budget')
    await subscribe(USER, LAPTOP)
    const { bodies, urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls).toEqual([LAPTOP])
    expect(tally.accounts).toBe(1)
    expect(tally.notifications).toBe(1)
    expect(tally.sent).toBe(1)
    expect(tally.marked).toBe(1)
    expect(pushedAt(USER, NOTE_ID), 'an announced row that is not stamped will be announced again').not.toBeNull()
    // Still a signal and a count, with none of the reader's words.
    expect(JSON.parse(bodies[0]!)).toEqual({ kind: 'inkstone:notifications', count: 1 })
    expect(bodies[0]!).not.toContain('digest')
    expect(bodies[0]!).not.toContain(NOTE_ID)
  })

  it('says nothing the second time, which is the whole of idempotency', async () => {
    insertNotification(USER, NOTE_ID, 'Stand up and stretch')
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)

    const first = await runPushCatchUp(env)
    const second = await runPushCatchUp(env)
    const third = await runPushCatchUp(env)

    expect(first.sent).toBe(1)
    expect(urls, 'the same notification was announced on more than one fire').toHaveLength(1)
    expect(second).toEqual(newPushFanoutTally())
    expect(third.accounts).toBe(0)
    expect(third.devices).toBe(0)
    expect(subscriptionReads, 'a fire with nothing to say still read the credential table').toHaveLength(1)
  })

  it('leaves a row the fan-out already announced alone', async () => {
    insertNotification(USER, NOTE_ID, 'Morning log')
    await storeFor(USER).markNotificationsPushed([NOTE_ID])
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls, 'a row some device already accepted was announced again').toEqual([])
    expect(tally.accounts).toBe(0)
  })

  it('does not wake a reader who has already opened it', async () => {
    insertNotification(USER, NOTE_ID, 'A page was written')
    await storeFor(USER).markRead(NOTE_ID)
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls).toEqual([])
    expect(tally.accountsWithoutDevice, 'a read row was still counted as one to announce').toBe(0)
  })

  it('stops announcing a row once it is no longer news', async () => {
    insertNotification(USER, NOTE_ID, 'What the routine said last week', Date.now() - PUSH_CATCHUP_WINDOW_MS - 60_000)
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls, 'a nudge went out for something older than the window').toEqual([])
    expect(tally.accounts).toBe(0)
    expect(pushedAt(USER, NOTE_ID)).toBeNull()
  })

  it('works off the rows one account at a time and never a neighbour\'s devices', async () => {
    insertNotification(USER, NOTE_ID, 'Ours')
    insertNotification(OTHER, '0123456789abcdefghjkmn0002', 'Theirs')
    await subscribe(USER, LAPTOP)
    await subscribe(OTHER, OTHER_LAPTOP)
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls.sort()).toEqual([LAPTOP, OTHER_LAPTOP].sort())
    expect(tally.accounts).toBe(2)
    expect(tally.notifications).toBe(2)
    expect(subscriptionReads).toHaveLength(2)
    expect(pushedAt(OTHER, '0123456789abcdefghjkmn0002')).not.toBeNull()
  })

  it('names the secret rather than the devices when the deployment cannot sign', async () => {
    insertNotification(USER, NOTE_ID, 'Stand up and stretch')
    await subscribe(USER, LAPTOP)
    env = envWith({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined })
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls).toEqual([])
    expect(subscriptionReads).toEqual([])
    expect(tally.configuration).toMatch(/VAPID_PRIVATE_KEY/)
    expect(pushedAt(USER, NOTE_ID), 'rows were stamped by a fire that sent nothing').toBeNull()
  })

  it('prunes the endpoint a service declares gone and keeps the row eligible', async () => {
    insertNotification(USER, NOTE_ID, 'Morning log')
    await subscribe(USER, LAPTOP)
    await subscribe(USER, PHONE)
    stubFetch((url) => url === LAPTOP ? new Response('Gone', { status: 410 }) : new Response('nope', { status: 500 }))
    const tally = await runPushCatchUp(env)

    expect(tally.expired).toBe(1)
    expect(tally.refused).toBe(1)
    expect(tally.sent).toBe(0)
    expect(tally.marked).toBe(0)
    // The gone device is gone from the table; the living one keeps its refusal count.
    expect((await storeFor(USER).listPushSubscriptions()).map((row) => row.endpoint)).toEqual([PHONE])
    expect((await storeFor(USER).listPushSubscriptions())[0]?.failures).toBe(1)
    // Nothing accepted the row, so it stays a candidate for the next fire.
    expect(pushedAt(USER, NOTE_ID)).toBeNull()
  })

  it('counts a fire that found nothing as nothing, without touching the credential table', async () => {
    const { urls } = stubFetch(ok)
    const tally = await runPushCatchUp(env)

    expect(urls).toEqual([])
    expect(subscriptionReads).toEqual([])
    expect(tally).toEqual(newPushFanoutTally())
  })
})

describe('the cron fire that carries it', () => {
  it('catches up on a drain fire', async () => {
    insertNotification(USER, NOTE_ID, 'What the 07:00 routine said')
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    await fireCron(15)

    expect(urls, 'the :15 fire did not make the catch-up send').toEqual([LAPTOP])
    expect(pushedAt(USER, NOTE_ID)).not.toBeNull()
  })

  it('is not the delivery path on the minute-granular fire between the drains', async () => {
    insertNotification(USER, NOTE_ID, 'What the 07:00 routine said')
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    // :30 is the fire the cron pattern produces between the drains, and the catch-up belongs to the drains.
    await fireCron(30)

    expect(urls, 'the catch-up ran on a fire that is not a drain fire').toEqual([])
    expect(pushedAt(USER, NOTE_ID)).toBeNull()
  })
})

describe('the shape the marker needs', () => {
  it('boots with the column and a partial index that leads with the account', () => {
    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('chat_notifications')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('pushed_at')
    const indexes = sqlite.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_notifications'`,
    ).all() as { name: string, sql: string }[]
    const unpushed = indexes.find((index) => index.name === 'idx_chat_notifications_unpushed')
    expect(unpushed, 'the index the catch-up fire reads every drain is missing').toBeTruthy()
    expect(unpushed!.sql).toContain('WHERE pushed_at IS NULL')
    expect(unpushed!.sql, 'an index that does not lead with the account can serve a neighbour\'s scan').toMatch(/\(user_id,/)
  })

  it('spends one version on the column and another on its index', () => {
    const column = SCHEMA_MIGRATIONS.find((migration) => migration.statements.some((text) => /chat_notifications ADD COLUMN pushed_at/.test(text)))
    const index = SCHEMA_MIGRATIONS.find((migration) => migration.statements.some((text) => /idx_chat_notifications_unpushed/.test(text)))
    expect(column?.version).toBe(106)
    expect(index?.version).toBe(107)
    expect(column?.skipIfColumnExists).toEqual({ table: 'chat_notifications', column: 'pushed_at' })
    expect(SCHEMA_MIGRATIONS.filter((migration) => migration.version === 106)).toHaveLength(1)
    expect(SCHEMA_MIGRATIONS.filter((migration) => migration.version === 107)).toHaveLength(1)
  })

  it('heals a database whose ledger claims the marker arrived without the column', async () => {
    // The two-lineage mistake this repo has been bitten by: the note says the work is done, the shape says
    // it is not, and a boot that trusted the note would refuse to serve the deployment.
    sqlite.exec(`DROP INDEX idx_chat_notifications_unpushed`)
    sqlite.exec(`ALTER TABLE chat_notifications DROP COLUMN pushed_at`)
    sqlite.exec(`INSERT OR IGNORE INTO schema_migrations VALUES (106, 1)`)
    sqlite.exec(`INSERT OR IGNORE INTO schema_migrations VALUES (107, 1)`)
    sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    await initializeDatabase(env)

    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('chat_notifications')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns, 'a spent version number hid the column and the boot served a half-built database').toContain('pushed_at')
    // And the repair did it without pretending a send happened: no row came back marked.
    insertNotification(USER, NOTE_ID, 'Older than the repair')
    expect(pushedAt(USER, NOTE_ID)).toBeNull()
  })
})
