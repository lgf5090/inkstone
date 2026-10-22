// @vitest-environment node
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { isValidSlug, newSlug } from '../src/worker/lib/id'
import { hashPassword } from '../src/worker/lib/password'
import type { AppBindings } from '../src/worker/env'
import { todoFeedRoutes } from '../src/worker/routes/todo-feeds'
import { todoRoutes } from '../src/worker/routes/todos'
import { buildIcsCalendar, rruleFor, type IcsCalendarOptions, type IcsTask } from '../src/worker/todos/ics'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const DAY = 24 * 60 * 60 * 1000

function task(overrides: Partial<IcsTask> & { id: string; dueAt: number }): IcsTask {
  return { title: 'Pay the bill', description: '', priority: 'medium', repeat: null, ...overrides }
}

function options(overrides: Partial<IcsCalendarOptions> = {}): IcsCalendarOptions {
  return { now: Date.parse('2026-03-01T00:00:00Z'), timezone: 'UTC', horizonMs: 90 * DAY, ...overrides }
}

/** Unfold the document the way a client would, so assertions read the logical property lines. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean)
}

function property(ics: string, name: string): string[] {
  return unfold(ics).filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1))
}

describe('RFC 5545 text escaping', () => {
  it('escapes backslash, comma, semicolon and newline in the order the spec requires', () => {
    const ics = buildIcsCalendar([task({
      id: 'a',
      dueAt: Date.parse('2026-03-02T09:00:00Z'),
      title: 'Buy a\\b, c; d',
      description: 'line one\nline two',
    })], options())

    expect(property(ics, 'SUMMARY')).toEqual(['Buy a\\\\b\\, c\\; d'])
    expect(property(ics, 'DESCRIPTION')).toEqual(['line one\\nline two'])
    // The escape must survive as data: a raw newline would have ended the property line.
    expect(ics).not.toContain('line one\nline two')
  })

  it('drops the control characters the spec forbids rather than emitting them raw', () => {
    const ics = buildIcsCalendar([task({ id: 'a', dueAt: Date.parse('2026-03-02T09:00:00Z'), title: 'x\u0000y\u001fz' })], options())
    expect(property(ics, 'SUMMARY')).toEqual(['xyz'])
  })

  it('folds long lines at 75 octets without splitting a multi-byte character', () => {
    const title = '价'.repeat(40) + '; tail'
    const ics = buildIcsCalendar([task({ id: 'a', dueAt: Date.parse('2026-03-02T09:00:00Z'), title })], options())
    for (const physical of ics.split('\r\n')) {
      expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75)
    }
    // Unfolding returns exactly what went in, so no byte of the title was lost to the fold.
    expect(property(ics, 'SUMMARY')).toEqual([title.replace(/;/g, '\\;')])
  })
})

describe('the time representation', () => {
  it('stamps DTSTAMP, DTSTART and DTEND in UTC with an explicit Z', () => {
    const ics = buildIcsCalendar([task({ id: 'a', dueAt: Date.parse('2026-03-02T09:30:00Z') })], options())
    expect(property(ics, 'DTSTAMP')).toEqual(['20260301T000000Z'])
    expect(property(ics, 'DTSTART')).toEqual(['20260302T093000Z'])
    expect(property(ics, 'DTEND')).toEqual(['20260302T100000Z'])
    expect(ics).toContain('PRODID:-//Inkstone//Todo Feed//EN')
  })

  it('keeps a UID stable for the same task instance across two fetches', () => {
    const one = property(buildIcsCalendar([task({ id: 'task-7', dueAt: Date.parse('2026-03-02T09:00:00Z') })], options()), 'UID')
    const two = property(
      buildIcsCalendar([task({ id: 'task-7', dueAt: Date.parse('2026-03-02T09:00:00Z') })], options({ now: Date.parse('2026-06-01T00:00:00Z') })),
      'UID',
    )
    expect(one).toEqual(['task-7@todo.inkstone'])
    expect(two).toEqual(one)
  })
})

describe('recurring tasks', () => {
  it('maps freq and interval onto FREQ and INTERVAL, and nothing else', () => {
    const due = Date.parse('2026-03-05T09:00:00Z')
    const cases: { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number; want: string }[] = [
      { freq: 'daily', interval: 1, want: 'FREQ=DAILY' },
      { freq: 'weekly', interval: 2, want: 'FREQ=WEEKLY;INTERVAL=2' },
      { freq: 'monthly', interval: 3, want: 'FREQ=MONTHLY;INTERVAL=3' },
      { freq: 'yearly', interval: 1, want: 'FREQ=YEARLY' },
    ]
    for (const entry of cases) {
      const rule = rruleFor(task({ id: 'r', dueAt: due, repeat: { freq: entry.freq, interval: entry.interval } }), options())
      expect(rule).toBe(entry.want)
    }
    // The vocabulary has no BYDAY, so a mapping that invented one would be caught here.
    expect(cases.every((entry) => !String(rruleFor(task({ id: 'r', dueAt: due, repeat: { freq: entry.freq, interval: entry.interval } }), options())).includes('BYDAY'))).toBe(true)
  })

  it('degrades a monthly rule anchored past the 28th to the single next occurrence', () => {
    // The app clamps Jan 31 forward to Feb 28; an RRULE would simply skip February. Two sequences,
    // so the honest export is the occurrence the app is actually holding and no RRULE at all.
    const thirtyFirst = task({ id: 'm', dueAt: Date.parse('2026-01-31T09:00:00Z'), repeat: { freq: 'monthly', interval: 1 } })
    expect(rruleFor(thirtyFirst, options({ now: Date.parse('2026-01-31T00:00:00Z') }))).toBeNull()
    const ics = buildIcsCalendar([thirtyFirst], options({ now: Date.parse('2026-01-31T00:00:00Z') }))
    expect(ics).not.toContain('RRULE')
    expect(property(ics, 'DTSTART')).toEqual(['20260131T090000Z'])
  })

  it('still exports a monthly rule anchored on or before the 28th', () => {
    const anchored = task({ id: 'm', dueAt: Date.parse('2026-01-15T09:00:00Z'), repeat: { freq: 'monthly', interval: 1 } })
    expect(rruleFor(anchored, options({ now: Date.parse('2026-01-15T00:00:00Z') }))).toBe('FREQ=MONTHLY')
  })

  it('degrades a yearly rule on 29 February and keeps one on an ordinary date', () => {
    const leap = task({ id: 'y', dueAt: Date.parse('2028-02-29T09:00:00Z'), repeat: { freq: 'yearly', interval: 1 } })
    expect(rruleFor(leap, options({ now: Date.parse('2028-02-29T00:00:00Z') }))).toBeNull()
    const ordinary = task({ id: 'y2', dueAt: Date.parse('2028-03-29T09:00:00Z'), repeat: { freq: 'yearly', interval: 1 } })
    expect(rruleFor(ordinary, options({ now: Date.parse('2028-03-29T00:00:00Z') }))).toBe('FREQ=YEARLY')
  })

  it('refuses an RRULE whose UTC anchor would drift across a daylight-saving change', () => {
    // 2026-03-08 is the US spring-forward: a fixed 02:00Z weekly series is not the 20:00 local series
    // the app keeps, so the window stops being flat and only the held occurrence is exported.
    const weekly = task({ id: 'd', dueAt: Date.parse('2026-03-06T02:00:00Z'), repeat: { freq: 'weekly', interval: 1 } })
    expect(rruleFor(weekly, options({ timezone: 'America/New_York', now: Date.parse('2026-03-06T00:00:00Z') }))).toBeNull()
    expect(rruleFor(weekly, options({ timezone: 'Asia/Shanghai', now: Date.parse('2026-03-06T00:00:00Z') }))).toBe('FREQ=WEEKLY')
  })
})

describe('what the export refuses to carry', () => {
  it('emits only calendar properties, never an internal column or the stored hash', () => {
    const ics = buildIcsCalendar([task({
      id: 't1',
      dueAt: Date.parse('2026-03-02T09:00:00Z'),
      title: 'Book the dentist',
      description: 'bring the card',
    })], options())
    // The document is assembled from a fixed set of keys; a column like `note_id`, `conversation_id`,
    // `project_id`, `list_id` or `password_hash` is structurally impossible to reach from here.
    const allowedKeys = /^(BEGIN|END|VERSION|PRODID|CALSCALE|METHOD|UID|DTSTAMP|DTSTART|DTEND|SUMMARY|DESCRIPTION|STATUS|PRIORITY|RRULE)$/
    for (const line of unfold(ics)) expect(allowedKeys.test(line.split(':')[0]!)).toBe(true)
    for (const forbidden of ['note_id', 'conversation_id', 'project_id', 'list_id', 'password_hash', 'scrypt']) {
      expect(ics).not.toContain(forbidden)
    }
  })
})

// --------------------------------------------------------------------- the feed route

let sqlite: DatabaseSync
let env: AppBindings['Bindings']

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/feeds', todoFeedRoutes)

async function fetchFeed(path: string): Promise<Response> {
  return app.request(`http://localhost${path}`, { method: 'GET' }, env)
}

function insertTask(input: {
  id: string
  userId: string
  title: string
  dueAt: number
  status?: string
  repeat?: unknown
  description?: string
}): void {
  sqlite
    .prepare(
      `INSERT INTO todos_tasks (user_id, id, title, description, status, priority, due_at, repeat_rule, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.id,
      input.title,
      input.description ?? '',
      input.status ?? 'todo',
      input.dueAt,
      input.repeat === undefined ? null : JSON.stringify(input.repeat),
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2026-01-01T00:00:00Z'),
    )
}

function insertFeed(input: {
  slug: string
  userId: string
  passwordHash?: string | null
  expiresAt?: number | null
  revokedAt?: number | null
}): void {
  sqlite
    .prepare(`INSERT INTO todos_feeds (slug, user_id, password_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      input.slug,
      input.userId,
      input.passwordHash ?? null,
      input.expiresAt ?? null,
      input.revokedAt ?? null,
      Date.now(),
    )
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('GET /feeds/:slug.ics', () => {
  const slug = 'abcdefghjkmnpqrstvwz'

  it('answers a live feed as text/calendar with no-store and nosniff', async () => {
    insertFeed({ slug, userId: USER })
    insertTask({ id: 't1', userId: USER, title: 'Water the plants', dueAt: Date.now() + DAY })

    const response = await fetchFeed(`/feeds/${slug}.ics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toContain('Water the plants')
  })

  it('serves the same document with or without the .ics suffix', async () => {
    insertFeed({ slug, userId: USER })
    insertTask({ id: 't1', userId: USER, title: 'Water the plants', dueAt: Date.now() + DAY })
    expect(await (await fetchFeed(`/feeds/${slug}.ics`)).text()).toContain('Water the plants')
    expect((await fetchFeed(`/feeds/${slug}`)).status).toBe(200)
  })

  it('exports only open tasks that have a due date, inside the window', async () => {
    insertFeed({ slug, userId: USER })
    insertTask({ id: 'overdue', userId: USER, title: 'Overdue', dueAt: Date.now() - 30 * DAY })
    insertTask({ id: 'soon', userId: USER, title: 'Soon', dueAt: Date.now() + DAY })
    insertTask({ id: 'far', userId: USER, title: 'Far away', dueAt: Date.now() + 400 * DAY })
    insertTask({ id: 'nodue', userId: USER, title: 'No due date', dueAt: 0, status: 'todo' })
    sqlite.prepare(`UPDATE todos_tasks SET due_at = NULL WHERE id = 'nodue'`).run()
    insertTask({ id: 'done', userId: USER, title: 'Already done', dueAt: Date.now() + DAY, status: 'done' })

    const body = await (await fetchFeed(`/feeds/${slug}.ics`)).text()
    expect(body).toContain('Overdue')
    expect(body).toContain('Soon')
    expect(body).not.toContain('Far away')
    expect(body).not.toContain('No due date')
    expect(body).not.toContain('Already done')
  })

  it('answers 404 for a revoked or expired feed', async () => {
    insertFeed({ slug, userId: USER, revokedAt: Date.now() })
    expect((await fetchFeed(`/feeds/${slug}.ics`)).status).toBe(404)

    const live = 'bbbbbbbbbbcccccccccc'
    insertFeed({ slug: live, userId: USER, expiresAt: Date.now() - 1000 })
    expect((await fetchFeed(`/feeds/${live}.ics`)).status).toBe(404)

    const future = 'ddddddddddvvvvvvvvvv'
    insertFeed({ slug: future, userId: USER, expiresAt: Date.now() + DAY })
    insertTask({ id: 't1', userId: USER, title: 'Still here', dueAt: Date.now() + DAY })
    expect((await fetchFeed(`/feeds/${future}.ics`)).status).toBe(200)
  })

  it('answers 404 for an unknown or malformed slug without probing the tables', async () => {
    expect((await fetchFeed('/feeds/short.ics')).status).toBe(404)
    expect((await fetchFeed(`/feeds/${'z'.repeat(20)}.ics`)).status).toBe(404)
  })

  it('withholds every task when the passcode is missing or wrong', async () => {
    insertFeed({ slug, userId: USER, passwordHash: await hashPassword('correct horse battery') })
    insertTask({ id: 't1', userId: USER, title: 'Secret meeting', dueAt: Date.now() + DAY })

    const missing = await fetchFeed(`/feeds/${slug}.ics`)
    expect(missing.status).toBe(401)
    expect(await missing.text()).not.toContain('Secret meeting')

    const wrong = await fetchFeed(`/feeds/${slug}.ics?key=totally-wrong-passcode`)
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).not.toContain('Secret meeting')

    const right = await fetchFeed(`/feeds/${slug}.ics?key=correct horse battery`)
    expect(right.status).toBe(200)
    expect(await right.text()).toContain('Secret meeting')
  })

  it('locks out a stream of wrong passcodes rather than verifying forever', async () => {
    insertFeed({ slug, userId: USER, passwordHash: await hashPassword('right passphrase') })
    insertTask({ id: 't1', userId: USER, title: 'Secret meeting', dueAt: Date.now() + DAY })

    const statuses: number[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      statuses.push((await fetchFeed(`/feeds/${slug}.ics?key=wrong attempt ${attempt}`)).status)
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
  })

  it('never resolves another account’s slug to that account’s tasks', async () => {
    insertFeed({ slug, userId: USER })
    insertTask({ id: 'mine', userId: USER, title: 'My own task', dueAt: Date.now() + DAY })
    insertTask({ id: 'theirs', userId: OTHER, title: 'Someone else task', dueAt: Date.now() + DAY })

    const body = await (await fetchFeed(`/feeds/${slug}.ics`)).text()
    expect(body).toContain('My own task')
    expect(body).not.toContain('Someone else task')
  })

  it('keys the lookup on the slug alone, so a value derived from the account id finds nothing', async () => {
    insertFeed({ slug, userId: USER })
    insertTask({ id: 'mine', userId: USER, title: 'My own task', dueAt: Date.now() + DAY })
    // Nothing here guesses a slug from `user_id`: the feed table is addressed by `slug` only, and the
    // route refuses a shape the minting generator would never produce before it even reads the table.
    expect((await fetchFeed(`/feeds/${USER}.ics`)).status).toBe(404)
    expect((await fetchFeed(`/feeds/${USER.slice(0, 20)}.ics`)).status).toBe(404)
  })

  it('mints slugs from 20 symbols of a 32-alphabet, so they are not enumerable', () => {
    const generated = Array.from({ length: 200 }, () => newSlug())
    expect(new Set(generated).size).toBe(200)
    // The whole unguessability claim: 20 characters over the 32-symbol alphabet is 100 bits of entropy,
    // and every minted slug is that fixed shape — which `isValidSlug` is what the route checks first.
    expect(generated.every((candidate) => /^[0-9a-hjkmnp-tv-z]{20}$/.test(candidate))).toBe(true)
    expect(generated.every((candidate) => isValidSlug(candidate))).toBe(true)
    expect(Math.log2(32 ** 20)).toBe(100)
  })
})

describe('the owner’s feed endpoints', () => {
  it('answer 401 without a session and write nothing', async () => {
    const manage = new Hono<AppBindings>()
    manage.onError((err, c) => errorResponse(c, err))
    manage.route('/api/todos', todoRoutes)

    const calls: Array<{ method: string; path: string; body?: string }> = [
      { method: 'GET', path: '/api/todos/feed' },
      { method: 'POST', path: '/api/todos/feed', body: '{}' },
      { method: 'DELETE', path: '/api/todos/feed/abcdefghjkmnpqrstvwz' },
    ]
    for (const call of calls) {
      const response = await manage.request(
        `http://localhost${call.path}`,
        {
          method: call.method,
          ...(call.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: call.body }),
        },
        env,
      )
      expect(response.status).toBe(401)
    }
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM todos_feeds').get() as { n: number }).n).toBe(0)
  })
})

describe('the deployment routes /feeds to the worker', () => {
  for (const config of ['wrangler.toml', 'wrangler.kv.toml']) {
    it(`lists /feeds/* in ${config}'s run_worker_first, with no comment in the file`, () => {
      const source = readFileSync(config, 'utf8')
      const block = /run_worker_first = \[([\s\S]*?)\]/.exec(source)?.[1]
      if (!block) throw new Error(`${config} has no run_worker_first list`)
      expect(block).toContain('/feeds/*')
      expect(source).not.toMatch(/^\s*#/)
    })
  }
})
