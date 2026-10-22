// @vitest-environment node
// Behavioural coverage for `src/worker/routes/settings.ts` (its three D1 statements now live in
// `src/worker/settings/store.ts`; the claims here are about what the routes answer, not about which
// file holds the SQL). The part worth pinning is the compare-and-set retry: the write only lands
// while the column still holds the text the caller merged from, and a stale session has to re-read
// rather than overwrite another device's edit.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { settingsRoutes } from '../src/worker/routes/settings'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = vi.hoisted(() => ({ userId: '', settingsRaw: '{}' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', {
      id: mocks.userId,
      username: mocks.userId,
      login: mocks.userId,
      name: '',
      avatarUrl: '',
      role: 'member',
      createdAt: 1,
      settingsRaw: mocks.settingsRaw,
    })
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/settings', settingsRoutes)

const ctx: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {} }

async function send(method: string, path: string, body?: unknown, userId = ALICE) {
  mocks.userId = userId
  mocks.settingsRaw = storedRaw(userId)
  // `app.route('/api/settings', …)` registers the group's `/` handler at the mount point itself, so
  // the bare collection is asked for without a trailing slash; the direct requests below do the same.
  return app.request(
    `/api/settings${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: db } as unknown as AppBindings['Bindings'],
    ctx,
  )
}

/** The session's view of the account: whatever the column holds right now, as the real middleware reads it. */
function storedRaw(userId: string): string {
  const row = sqlite.prepare('SELECT settings FROM users WHERE id = ?').get(userId) as { settings: string } | undefined
  return row?.settings ?? '{}'
}

function account(id: string, username: string, settings = '{}') {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, '', '', 'member', ?, 1, 1)`,
    )
    .run(id, username, username, settings)
}

function column(userId: string): string {
  return (sqlite.prepare('SELECT settings FROM users WHERE id = ?').get(userId) as { settings: string }).settings
}

function note(id: string, userId: string, overrides: { words?: number; chars?: number; deletedAt?: number | null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO notes (id, user_id, title, content, word_count, char_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, '', '', ?, ?, 1, 1, ?)`,
    )
    .run(id, userId, overrides.words ?? 0, overrides.chars ?? 0, overrides.deletedAt ?? null)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  account(ALICE, 'alice')
  account(BOB, 'bob')
})

describe('reading settings', () => {
  it('answers the stored half over the defaults', async () => {
    sqlite.prepare("UPDATE users SET settings = '{\"appearance\":{\"language\":\"en-US\"}}' WHERE id = ?").run(ALICE)
    const body = await (await send('GET', '')).json() as Record<string, Record<string, unknown>>
    expect(body.appearance.language).toBe('en-US')
    expect(body.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme)
    expect(body.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize)
  })

  it('keeps one account out of another’s settings', async () => {
    sqlite.prepare("UPDATE users SET settings = '{\"appearance\":{\"proseSize\":24}}' WHERE id = ?").run(ALICE)
    const body = await (await send('GET', '', undefined, BOB)).json() as Record<string, Record<string, unknown>>
    expect(body.appearance.proseSize).toBe(DEFAULT_SETTINGS.appearance.proseSize)
  })
})

describe('writing settings', () => {
  it('merges a section patch and stores exactly what it answered', async () => {
    sqlite.prepare("UPDATE users SET settings = '{\"appearance\":{\"language\":\"en-US\"}}' WHERE id = ?").run(ALICE)
    const response = await send('PUT', '', { editor: { fontSize: 18 } })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, Record<string, unknown>>
    expect(body.editor.fontSize).toBe(18)
    expect(body.appearance.language).toBe('en-US')
    expect(JSON.parse(column(ALICE))).toEqual(body)
  })

  it('re-reads and merges from the newer row when the session copy is stale', async () => {
    // The session still carries `{}` while the column has moved on to proseSize 20, so the first
    // compare-and-set matches nothing and the answer has to come from the row, not the session.
    sqlite.prepare("UPDATE users SET settings = '{\"appearance\":{\"proseSize\":20}}' WHERE id = ?").run(ALICE)
    mocks.settingsRaw = '{}'
    mocks.userId = ALICE
    const response = await app.request(
      '/api/settings',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editor: { tabSize: 4 } }) },
      { DB: db } as unknown as AppBindings['Bindings'],
      ctx,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, Record<string, unknown>>
    expect(body.appearance.proseSize).toBe(20)
    expect(body.editor.tabSize).toBe(4)
    expect(JSON.parse(column(ALICE)).appearance.proseSize).toBe(20)
  })

  it('answers 401 when the account behind the session is gone', async () => {
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(ALICE)
    const response = await send('PUT', '', { editor: { tabSize: 4 } })
    expect(response.status).toBe(401)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('unauthenticated')
  })

  it('writes only the account the session names', async () => {
    sqlite.prepare("UPDATE users SET settings = '{\"appearance\":{\"proseSize\":21}}' WHERE id = ?").run(BOB)
    const written = await send('PUT', '', { editor: { fontSize: 22 } }, ALICE)
    expect(written.status).toBe(200)
    expect(JSON.parse(column(BOB)).appearance.proseSize).toBe(21)
    expect(JSON.parse(column(ALICE)).editor.fontSize).toBe(22)
  })
})

describe('the templater section', () => {
  // The settings panel for Templater writes one field at a time and the whole list at once, and every field of
  // the blob feeds a gate: a lost `communityScriptPolicy` or `webRequestsEnabled` is a permission quietly
  // changed, and a lost `startupTemplates` is a template that stopped running with nothing on screen to say so.
  const WRITTEN = {
    ...DEFAULT_SETTINGS.templater,
    syntaxHighlighting: false,
    syntaxHighlightingMobile: true,
    autoJumpToCursor: true,
    jumpToContentAfterCreate: true,
    intellisenseRender: '3',
    fileCreationMode: 'regex',
    folderTemplates: [{ folderId: 'f-journal', templateId: 't-daily' }, { folderId: null, templateId: 't-any' }],
    fileTemplates: [{ regex: '^Journal/', templateId: 't-daily' }],
    ignoreFoldersOnCreation: ['f-trash'],
    startupTemplates: ['t-welcome'],
    templateHotkeys: [{ templateId: 't-daily', combo: 'ctrl+alt+d', insert: true, create: false }],
    userScriptsFolderId: 'f-scripts',
    communityScriptPolicy: 'trusted',
    webRequestsEnabled: true,
  }

  it('keeps every field of the templater blob through a write', async () => {
    const response = await send('PUT', '', { templater: WRITTEN })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.templater).toEqual(WRITTEN)
    expect(JSON.parse(column(ALICE)).templater).toEqual(WRITTEN)
  })

  it('leaves the rest of the section alone when one field is patched', async () => {
    sqlite.prepare('UPDATE users SET settings = ? WHERE id = ?')
      .run(JSON.stringify({ templater: WRITTEN }), ALICE)
    const response = await send('PUT', '', { templater: { webRequestsEnabled: false } })
    const body = await response.json() as { templater: typeof WRITTEN }
    expect(body.templater.webRequestsEnabled).toBe(false)
    expect(body.templater.folderTemplates).toEqual(WRITTEN.folderTemplates)
    expect(body.templater.userScriptsFolderId).toBe('f-scripts')
    expect(body.templater.communityScriptPolicy).toBe('trusted')
  })

  it('refuses a templater value the section cannot store instead of saving it', async () => {
    // The panel cannot send these, but the endpoint is the trust boundary: an unreadable level falls back to
    // the shipped default, and two rules for one template are one rule, because the second would never fire.
    const response = await send('PUT', '', {
      templater: {
        intellisenseRender: '9',
        startupTemplates: ['t-a', 't-a', '', 't-b'],
        folderTemplates: [
          { folderId: 'f-1', templateId: 't-dup' },
          { folderId: 'f-2', templateId: 't-dup' },
        ],
      },
    })
    const body = await response.json() as { templater: Record<string, unknown> }
    expect(body.templater.intellisenseRender).toBe(DEFAULT_SETTINGS.templater.intellisenseRender)
    expect(body.templater.startupTemplates).toEqual(['t-a', 't-b'])
    expect(body.templater.folderTemplates).toEqual([{ folderId: 'f-1', templateId: 't-dup' }])
  })
})

describe('account statistics', () => {  it('counts this account across every table the card shows', async () => {
    note('n-live', ALICE, { words: 7, chars: 40 })
    note('n-archived', ALICE, { words: 3, chars: 12 })
    note('n-trash', ALICE, { deletedAt: 5, words: 100, chars: 900 })
    note('n-bob', BOB, { words: 9, chars: 9 })
    sqlite.prepare('INSERT INTO folders (id, user_id, name, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('f-1', ALICE, 'Inbox', null, 1, 1)
    sqlite.prepare('INSERT INTO folders (id, user_id, name, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('f-gone', ALICE, 'Old', 5, 1, 1)
    sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?,?,?,?)').run('t-1', ALICE, 'idea', 1)
    sqlite
      .prepare('INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('v-1', 'n-live', ALICE, 'Live', '', 40, 1)
    sqlite
      .prepare('INSERT INTO links (source_note_id, target_key, target_title, user_id) VALUES (?,?,?,?)')
      .run('n-live', 'gone', 'Gone', ALICE)
    sqlite
      .prepare('INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('a-1', ALICE, 'n-live', 'p.png', 'image/png', 300, 'sha', 'kv', 1)
    sqlite
      .prepare('INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('a-2', BOB, null, 'q.png', 'image/png', 700, 'sha', 'kv', 1)

    const body = await (await send('GET', '/stats')).json() as Record<string, number>
    expect(body).toEqual({
      notes: 2,
      trashed: 1,
      folders: 1,
      tags: 1,
      attachments: 1,
      attachmentBytes: 300,
      chars: 52,
      words: 10,
      versions: 1,
      links: 1,
    })

    const asBob = await (await send('GET', '/stats', undefined, BOB)).json() as Record<string, number>
    expect(asBob).toEqual({
      notes: 1,
      trashed: 0,
      folders: 0,
      tags: 0,
      attachments: 1,
      attachmentBytes: 700,
      chars: 9,
      words: 9,
      versions: 0,
      links: 0,
    })
  })

  it('answers zeroes for an account that has stored nothing', async () => {
    const body = await (await send('GET', '/stats')).json() as Record<string, number>
    expect(Object.values(body)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})
