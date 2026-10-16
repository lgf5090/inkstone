// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase, REQUIRED_COLUMNS, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * What a deploy must do when the database it lands on disagrees with it.
 *
 * The migration ledger is a note about work done, not the work. Two branches of this app numbered
 * their migrations independently, so a database built by one reads the other's numbers as already
 * spent — and a boot that trusted the note would then reject the shape it demands, turning every
 * request into a 500. These tests drop the shape while leaving the note, which is exactly that
 * situation, and require the boot to heal it.
 */

function columnsOf(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(row => (row as { name: string }).name)
}

function tablesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => (row as { name: string }).name)
}

function ddlOf(sqlite: DatabaseSync, table: string): string {
  return (sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }).sql
}

function indexesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map(row => (row as { name: string }).name)
}

const TABLES = SCHEMA_STATEMENTS.filter((text) => /^\s*CREATE TABLE IF NOT EXISTS/.test(text))
const ADDITIONS = SCHEMA_MIGRATIONS.flatMap((migration) => migration.statements)

async function boot(sqlite: DatabaseSync): Promise<D1Database> {
  const db = makeD1(sqlite)
  await initializeDatabase({ DB: db } as never)
  return db
}

/**
 * Boot the way a deploy does.
 *
 * A boot whose stored fingerprint still matches the code returns before it looks at the schema, so
 * this drops that note first: what a new build sees is a database whose shape may have drifted
 * while nobody was looking at it.
 */
function reboot(sqlite: DatabaseSync): Promise<D1Database> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  return boot(sqlite)
}

async function installed(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await boot(sqlite)
  return sqlite
}

describe('a boot onto a database whose ledger lies', () => {
  it('re-adds the columns a spent version number would have hidden', async () => {
    const sqlite = await installed()
    for (const column of ['rss', 'template_library', 'quickadd']) {
      sqlite.exec(`ALTER TABLE users DROP COLUMN ${column}`)
    }
    expect(columnsOf(sqlite, 'users')).not.toContain('rss')
    // The other lineage's ledger runs past every number this one owns, so each of them reads as spent.
    // Derived, because the array grows: a hardcoded window would collide with the real numbers the
    // first boot just recorded.
    const firstFree = Math.max(...SCHEMA_MIGRATIONS.map((migration) => migration.version)) + 1
    for (let version = firstFree; version < firstFree + 26; version++) sqlite.exec(`INSERT INTO schema_migrations VALUES (${version}, 1)`)

    await reboot(sqlite)
    const users = columnsOf(sqlite, 'users')
    expect(users).toContain('rss')
    expect(users).toContain('template_library')
    expect(users).toContain('quickadd')
  })

  it('creates a required table whose migration number is already taken', async () => {
    const sqlite = await installed()
    sqlite.exec('DROP TABLE rewrite_queue')
    expect(tablesOf(sqlite)).not.toContain('rewrite_queue')
    await reboot(sqlite)
    expect(tablesOf(sqlite)).toContain('rewrite_queue')
    expect(columnsOf(sqlite, 'rewrite_queue')).toContain('claimed_at')
  })

  it('gives a skill library built before icons the column it now reads', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO chat_prompts (user_id, id, title, content, group_name, tools, scopes, model_id, icon, created_at, updated_at)
      VALUES ('u1', 's1', '周报', '按项目分段。', '', '[]', '[]', NULL, '📝', 1, 1)`)
    // The shape a database built before version 81 has: the rows are there, the column is not, and the
    // ledger has not spent the number either — so the migration itself is what has to carry them across.
    sqlite.exec('ALTER TABLE chat_prompts DROP COLUMN icon')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 81')
    expect(columnsOf(sqlite, 'chat_prompts')).not.toContain('icon')

    await reboot(sqlite)
    expect(columnsOf(sqlite, 'chat_prompts')).toContain('icon')
    // The row survives the rebuild with the empty icon every pre-existing skill is meant to read as.
    expect(sqlite.prepare(`SELECT title, icon FROM chat_prompts WHERE id = 's1'`).get()).toEqual({ title: '周报', icon: '' })
  })

  it('keeps the data of the rows it does not touch', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
      VALUES ('u1', 'keeper', 'x', 'keeper', '', 'owner', '{}', 1, 1)`)
    sqlite.exec(`INSERT INTO rss_feed (user_id, id, url, title, pinned) VALUES ('u1', 'f1', 'https://a.test/feed', 'A', 1)`)
    sqlite.exec('ALTER TABLE users DROP COLUMN rss')
    await reboot(sqlite)
    const feed = sqlite.prepare(`SELECT title, pinned FROM rss_feed WHERE id = 'f1'`).get() as { title: string; pinned: number }
    expect(feed).toEqual({ title: 'A', pinned: 1 })
    expect(columnsOf(sqlite, 'users')).toContain('rss')
  })

  it('heals two columns that arrived under two different version numbers', async () => {
    const sqlite = await installed()
    sqlite.exec('ALTER TABLE rewrite_queue DROP COLUMN attempts')
    sqlite.exec('ALTER TABLE rewrite_queue DROP COLUMN claimed_at')
    expect(columnsOf(sqlite, 'rewrite_queue')).not.toContain('attempts')
    await reboot(sqlite)
    const queue = columnsOf(sqlite, 'rewrite_queue')
    expect(queue).toContain('attempts')
    expect(queue).toContain('claimed_at')
    expect(queue).toContain('old_value')
  })

  it('refuses rather than inventing a column nothing in the schema describes', async () => {
    // The repair can only replay what this file already declares, so a required column must be
    // findable there: otherwise a branch could add a column to the demand list and to no DDL, and
    // every boot would then brick the database it landed on.
    const sqlite = await installed()
    const declared = new Set<string>()
    for (const statement of [...TABLES, ...ADDITIONS]) {
      for (const match of statement.matchAll(/ADD\s+COLUMN\s+(\w+)/gi)) declared.add(match[1])
      const body = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)/i.exec(statement.trim())
      if (!body) continue
      for (const line of body[2].split('\n')) {
        const column = /^\s*(\w+)\s+/.exec(line.trim())
        if (column && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(column[1])) declared.add(`${body[1]}.${column[1]}`)
      }
    }
    const missing: string[] = []
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) {
        if (!declared.has(`${table}.${column}`) && !declared.has(column)) missing.push(`${table}.${column}`)
      }
    }
    expect(missing).toEqual([])
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toBeTruthy()
  })

  it('refuses a repair that would add the primary key column a table declares', async () => {
    // SQLite forbids `ADD COLUMN ... PRIMARY KEY`, so the repair has to decline the column and let the
    // boot name the incompatibility out loud. The ordinary columns beside it must still be healed: the
    // refusal is about the key, not about the table.
    const sqlite = await installed()
    sqlite.exec('DROP TABLE totp_credentials')
    sqlite.exec('CREATE TABLE totp_credentials (placeholder TEXT)')
    await expect(reboot(sqlite)).rejects.toThrow('totp_credentials is missing user_id')
    const columns = columnsOf(sqlite, 'totp_credentials')
    expect(columns).not.toContain('user_id')
    expect(columns).toContain('last_used_by')
  })

  it('refuses a repair that would add the unique column a table declares', async () => {
    const sqlite = await installed()
    sqlite.exec('DROP TABLE mcp_api_keys')
    sqlite.exec('CREATE TABLE mcp_api_keys (user_id TEXT NOT NULL, revoked_at INTEGER)')
    await expect(reboot(sqlite)).rejects.toThrow(/mcp_api_keys is missing .*key_hash/)
    const columns = columnsOf(sqlite, 'mcp_api_keys')
    expect(columns).not.toContain('key_hash')
    expect(columns).not.toContain('id')
    expect(columns).toContain('name')
  })

  it('is a no-op on a database that already matches', async () => {
    const sqlite = await installed()
    const before = tablesOf(sqlite).join(',')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await reboot(sqlite)
      expect(tablesOf(sqlite).join(',')).toBe(before)
      expect(warn.mock.calls.filter(call => String(call[1] ?? call[0]).includes('Schema repair'))).toHaveLength(0)
    }
    finally {
      warn.mockRestore()
    }
  })
})

/**
 * The one shape this boot has to rewrite rather than add to.
 *
 * `reader_books` shipped with the book id alone as its primary key, and that id is minted by the client
 * from the file's name and size — so two accounts that shelved the same file landed on the same key and
 * a push from either replaced the other's row away. A primary key cannot be ALTERed, so the table is
 * rebuilt in place, and the repair has to prove it carries the rows over instead of merely surviving.
 */
describe('a shelf still keyed the way the first reader left it', () => {
  const LEGACY_BOOKS = `CREATE TABLE reader_books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    filename TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    unit_count INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    toc TEXT NOT NULL DEFAULT '[]',
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    has_blob INTEGER NOT NULL DEFAULT 0,
    cover_key TEXT,
    cover_size INTEGER NOT NULL DEFAULT 0
  )`

  function legacyShelf(): string {
    return `INSERT INTO reader_books (id, user_id, title, format, filename, r2_key, added_at, updated_at)
      VALUES ('file:dao.epub:4096', 'alice', 'dao', 'epub', 'dao.epub', 'reader/alice/dao.epub', 1, 1)`
  }

  async function drifted(): Promise<DatabaseSync> {
    const sqlite = await installed()
    sqlite.exec('DROP TABLE reader_books')
    sqlite.exec(LEGACY_BOOKS)
    sqlite.exec(legacyShelf())
    expect(ddlOf(sqlite, 'reader_books')).toMatch(/id TEXT PRIMARY KEY/)
    return sqlite
  }

  it('rebuilds the key and keeps the row that was already there', async () => {
    const sqlite = await drifted()
    await reboot(sqlite)
    expect(ddlOf(sqlite, 'reader_books')).toMatch(/PRIMARY KEY \(user_id, id\)/)
    expect(sqlite.prepare(`SELECT title, r2_key FROM reader_books`).all()).toEqual([
      { title: 'dao', r2_key: 'reader/alice/dao.epub' },
    ])
    // Dropping the table drops its index with it, so the rebuild has to put it back or the boot
    // would refuse the schema it just repaired.
    expect(indexesOf(sqlite)).toContain('idx_reader_books_user')
  })

  it('lets a second account shelve the same file afterwards', async () => {
    const sqlite = await drifted()
    await reboot(sqlite)
    sqlite.exec(`INSERT INTO reader_books (id, user_id, title, format, filename, r2_key, added_at, updated_at)
      VALUES ('file:dao.epub:4096', 'bob', 'dao', 'epub', 'dao.epub', 'reader/bob/dao.epub', 2, 2)`)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM reader_books`).get()).toEqual({ n: 2 })
  })

  it('does not rebuild a shelf it already repaired', async () => {
    const sqlite = await drifted()
    await reboot(sqlite)
    sqlite.exec(`UPDATE reader_books SET title = 'kept' WHERE user_id = 'alice'`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await reboot(sqlite)
      expect(sqlite.prepare(`SELECT title FROM reader_books`).get()).toEqual({ title: 'kept' })
      expect(warn.mock.calls.filter(call => String(call[0]).includes('reader_books'))).toHaveLength(0)
    }
    finally {
      warn.mockRestore()
    }
  })
})

/**
 * A table that holds one account's rows must lead its key with that account.
 *
 * `reader_books` shipped with `id TEXT PRIMARY KEY` while every other reader table led with
 * `user_id`, and its id is minted by the client from the file's name and size — so two accounts that
 * shelved the same file held the same key and one account's push replaced the other's row away. The
 * routes all bound `user_id`, so nothing leaked; the row was simply gone, and no test could see it.
 * That is why this is checked against the declaration rather than the queries: a missing predicate is
 * visible in a route review, a key that lets one account overwrite another is only visible in the DDL.
 *
 * Every entry below is a claim about where that table's id comes from, not a granted exemption.
 */
const ACCOUNT_GLOBAL_KEYS = new Map<string, string>([
  // The id is minted by `newId()` — 26 characters from a 32-symbol alphabet, 16 of them from
  // `crypto.getRandomValues` — so no other account can name the same row.
  ['notes', 'newId() in routes/notes.ts'],
  ['note_versions', 'newId() in mcp/writes.ts'],
  ['attachments', 'newId() in routes/files.ts:93'],
  ['backup_targets', 'newId() in the target create'],
  ['backup_runs', 'newId() in backup/engine.ts'],
  ['mcp_api_keys', 'newId() in mcp/api-keys.ts:62'],
  ['totp_login_challenges', 'newId() per challenge in lib/totp-service.ts'],
  // Offered by the client so a re-sync of the same note or folder is idempotent, and therefore open
  // to the exact collision `reader_books` fell into — refused instead, by a cross-account id probe
  // that answers 409 before the insert (`idTakenByAnyone` in folders/store.ts and tags/store.ts).
  ['folders', 'client-offered id, guarded by idTakenByAnyone -> 409'],
  ['tags', 'client-offered id, guarded by idTakenByAnyone -> 409'],
  // A session row is keyed by the hash of a 32-byte crypto token (lib/session-store.ts:6,27), so the
  // key is a secret rather than a name; it carries no per-account rows to overwrite.
  ['sessions', 'sha256 of a crypto-random token'],
  // Public by slug and minted by `newSlug()` (routes/share.ts:141); presence is one room per share,
  // which is why the slug, not the account, is the identity of the row.
  ['shares', 'newSlug(), unguessable'],
  ['share_presence', 'one room per share slug'],
  // The conversation share keeps the shape the note share was verified on: the same `newSlug()`, and a
  // public read that must find the row without knowing the owner, because the link *is* the capability.
  ['chat_share_links', 'newSlug(), unguessable; public read by slug alone'],
  // A monotonic ledger counter: the whole point is a sequence no account may restart, and every read
  // filters on `user_id`.
  ['changes', 'seq INTEGER PRIMARY KEY AUTOINCREMENT'],
  // The key names a stored object (`r2:<user_id>/<newId>.<ext>`, attachments/keys.ts:12), and one
  // object belongs to exactly one account — the queue is a work list of objects, not of rows.
  ['attachment_cleanup', 'object key embeds the owner id'],
  // Composite, but not leading with the account: a wiki link is one edge from a note, and the source
  // note id is already `newId()`-random and account-owned, so `target_key` cannot name another
  // account's edge. Reads scope by `user_id` (idx_links_user_source).
  ['links', 'composite (source_note_id, target_key) on account-owned notes'],
])

/** The tables that carry a `user_id` column yet key on something else. */
function globalKeyedTenantTables(statements: readonly string[] = TABLES): string[] {
  const offenders: string[] = []
  for (const statement of statements) {
    const body = /^\s*CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*$/i.exec(statement.trim())
    if (!body) continue
    const [, table, columns] = body
    if (!/\buser_id\s+TEXT\b/i.test(columns!)) continue
    // Two shapes declare a key: a column annotated `PRIMARY KEY`, and a table-level composite.
    const composite = /PRIMARY KEY\s*\(([^)]*)\)/i.exec(columns!)
    if (composite) {
      if (/^\s*user_id\b/i.test(composite[1]!)) continue
      offenders.push(`${table} (composite: ${composite[1].trim()})`)
      continue
    }
    const single = /(\w+)\s+\w+(?:\([^)]*\))?\s+(?:NOT NULL\s+)?PRIMARY KEY/i.exec(columns!)
    if (single && single[1]!.toLowerCase() !== 'user_id') offenders.push(`${table} (single: ${single[1]})`)
  }
  return offenders
}

describe('every account-scoped table leads its key with the account', () => {
  it('keys each table holding one account rows on that account, except the verified list', () => {
    const offenders = globalKeyedTenantTables()
      .map((entry) => entry.split(' ')[0])
      .filter((table) => !ACCOUNT_GLOBAL_KEYS.has(table))
    expect(offenders, `tables that carry user_id yet key globally: ${offenders.join(', ') || 'none'}`).toEqual([])
  })

  it('does not let an entry on the verified list go stale', () => {
    // Two directions, like every other allowlist here: a table that was fixed has to lose its entry.
    const stillGlobal = new Set(globalKeyedTenantTables().map((entry) => entry.split(' ')[0]))
    const paid = [...ACCOUNT_GLOBAL_KEYS.keys()].filter((table) => !stillGlobal.has(table))
    expect(paid, `no longer globally keyed — delete the entry: ${paid.join(', ')}`).toEqual([])
  })

  it('names the shape that made this guard necessary, instead of trusting the current tree', () => {
    // Positive control. Without it this file only proves that today's schema happens to pass, and a
    // guard that cannot fail is the kind of assurance `reader_books` already had.
    const legacyShaped = [`CREATE TABLE IF NOT EXISTS reader_books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL
    )`]
    expect(globalKeyedTenantTables(legacyShaped)).toEqual(['reader_books (single: id)'])
    // The same table with the account leading its key is not an offender, so the rule is about the
    // shape and not about this table's name.
    expect(globalKeyedTenantTables([`CREATE TABLE IF NOT EXISTS reader_books (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    )`])).toEqual([])
  })
})
