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

  it('moves an MCP server’s switched-off list into the per-tool answers', async () => {
    const sqlite = await installed()
    // The shape a database built before version 82 has: the old list column and no map. (A fresh install
    // carries the old column too, because the migration that first created this table declared it and a
    // migration is history — the new schema does not, so nothing reads it there and nothing writes it.)
    sqlite.exec(`INSERT INTO chat_mcp_servers (user_id, id, label, url, enabled, tool_mode, disabled_tools, created_at, updated_at)
      VALUES ('u1', 's1', 'Example', 'https://mcp.example.test/mcp', 1, 'ask', '["drop_everything"]', 1, 1)`)
    sqlite.exec('ALTER TABLE chat_mcp_servers DROP COLUMN tool_modes')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 82')
    expect(columnsOf(sqlite, 'chat_mcp_servers')).not.toContain('tool_modes')

    await reboot(sqlite)
    expect(columnsOf(sqlite, 'chat_mcp_servers')).toContain('tool_modes')
    // One column for one setting: the list is converted rather than carried beside the map it became.
    expect(sqlite.prepare(`SELECT tool_modes FROM chat_mcp_servers WHERE id = 's1'`).get()).toEqual({ tool_modes: '{"drop_everything":"off"}' })
  })

  it('brings a conversation that predates the flag back as a kept one', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO chat_conversations (user_id, id, title, ephemeral, created_at, updated_at)
      VALUES ('u1', 'c1', 'Keeper', 0, 1, 1)`)
    // The shape a database built before version 85 has. The default is the whole point: read the other way,
    // every conversation that already exists would come back as a temporary one and vanish from the list —
    // which is the failure this column could most easily have been.
    sqlite.exec('ALTER TABLE chat_conversations DROP COLUMN ephemeral')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 85')
    expect(columnsOf(sqlite, 'chat_conversations')).not.toContain('ephemeral')

    await reboot(sqlite)
    expect(columnsOf(sqlite, 'chat_conversations')).toContain('ephemeral')
    expect(sqlite.prepare(`SELECT title, ephemeral FROM chat_conversations WHERE id = 'c1'`).get())
      .toEqual({ title: 'Keeper', ephemeral: 0 })
  })

  it('reads a share link that predates the scope as the whole thread, and moves its key', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO chat_share_links (slug, conversation_id, user_id, created_at) VALUES ('s1', 'c1', 'u1', 1)`)
    // The shape a database built before version 86 has: no scope column, and a key that admits one link per
    // conversation. The index goes before the column, which SQLite will not drop while something is keyed
    // on it.
    sqlite.exec('DROP INDEX IF EXISTS idx_chat_share_links_scope')
    sqlite.exec('ALTER TABLE chat_share_links DROP COLUMN scope')
    sqlite.exec('CREATE UNIQUE INDEX idx_chat_share_links_conversation ON chat_share_links(user_id, conversation_id)')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 86')

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'chat_share_links')).toContain('scope')
    // Every link made before this column existed published the whole thread, which is the reading that
    // loses nothing — the other way round, a conversation already sent to somebody would come back showing
    // a single message.
    expect(sqlite.prepare(`SELECT scope FROM chat_share_links WHERE slug = 's1'`).get()).toEqual({ scope: '' })
    // And the key now admits a second publication of the same thread.
    expect(indexesOf(sqlite)).toContain('idx_chat_share_links_scope')
    expect(indexesOf(sqlite)).not.toContain('idx_chat_share_links_conversation')
    sqlite.exec(`INSERT INTO chat_share_links (slug, conversation_id, user_id, scope, created_at)
      VALUES ('s2', 'c1', 'u1', '01jqz0000000000000000000aa', 1)`)
  })

  it('files a fact that predates the scope as the account\'s own', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO chat_memories (id, user_id, content, category, source, status, created_at, updated_at)
      VALUES ('m1', 'u1', 'Prefers tea', 'preference', 'manual', 'active', 1, 1)`)
    // The shape a database built before version 87 has. Every fact that existed then was learned in the
    // account's own context, so null — which is what "no project" means — is the reading that loses
    // nothing; a default would say the same thing while pretending a project had been chosen.
    sqlite.exec('ALTER TABLE chat_memories DROP COLUMN project_id')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 87')

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'chat_memories')).toContain('project_id')
    expect(sqlite.prepare(`SELECT content, project_id FROM chat_memories WHERE id = 'm1'`).get())
      .toEqual({ content: 'Prefers tea', project_id: null })
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

  it('gives an older database the two indexes its new sort orders read', async () => {
    const sqlite = await installed()
    // The shape a database built before versions 129 and 130 has: neither index, and neither number
    // spent. Both sort paths order by a column only the account scopes, so the index has to exist on
    // the left of them or every page of a long-lived account sorts its whole table.
    sqlite.exec('DROP INDEX idx_todos_tasks_created')
    sqlite.exec('DROP INDEX idx_todos_tasks_completed')
    sqlite.exec('DELETE FROM schema_migrations WHERE version IN (129, 130)')
    expect(indexesOf(sqlite)).not.toContain('idx_todos_tasks_created')

    await reboot(sqlite)

    expect(indexesOf(sqlite)).toContain('idx_todos_tasks_created')
    expect(indexesOf(sqlite)).toContain('idx_todos_tasks_completed')
    // One number per index, recorded, so the boot after this one does not replay them.
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version IN (129, 130) ORDER BY version`).all())
      .toEqual([{ version: 129 }, { version: 130 }])
  })

  it('gives an older database the day columns and their index even when its ledger claims both', async () => {
    const sqlite = await installed()
    sqlite.exec('DROP INDEX idx_todos_tasks_completed_on')
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN created_on')
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN completed_on')
    expect(columnsOf(sqlite, 'todos_tasks')).not.toContain('created_on')
    // The numbers stay spent: a branch that used 131/132/133 for other work is exactly the situation
    // the shape repair exists for, and a column cannot be hidden behind a ledger note.
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version IN (131, 132, 133) ORDER BY version`).all())
      .toEqual([{ version: 131 }, { version: 132 }, { version: 133 }])

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'todos_tasks')).toEqual(expect.arrayContaining(['created_on', 'completed_on']))
    expect(indexesOf(sqlite)).toContain('idx_todos_tasks_completed_on')
  })

  it('gives a list table built before archiving and grouping both columns', async () => {
    const sqlite = await installed()
    sqlite.exec('ALTER TABLE todos_lists DROP COLUMN parent_id')
    sqlite.exec('ALTER TABLE todos_lists DROP COLUMN archived_at')
    expect(columnsOf(sqlite, 'todos_lists')).not.toContain('archived_at')
    // Both numbers stay spent: an older list table has to be healed by the shape, not by the note.
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version IN (137, 138) ORDER BY version`).all())
      .toEqual([{ version: 137 }, { version: 138 }])

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'todos_lists')).toEqual(expect.arrayContaining(['archived_at', 'parent_id']))
  })

  it('gives an account that predates the to-do read switch the switch, on', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO mcp_preferences (user_id, write_enabled, trash_enabled, disabled_tools, updated_at)
      VALUES ('u1', 1, 0, '[]', 1)`)
    // The shape a database built before version 141 has. The number stays spent, because a branch that
    // used 141 for other work is exactly the collision the shape repair exists for — and 116 was once
    // reserved for this column, so a ledger note that hides it is not hypothetical.
    sqlite.exec('ALTER TABLE mcp_preferences DROP COLUMN todo_read_enabled')
    expect(columnsOf(sqlite, 'mcp_preferences')).not.toContain('todo_read_enabled')

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'mcp_preferences')).toContain('todo_read_enabled')
    // On, the way it was for every account that could already read tasks through its keys.
    expect(sqlite.prepare(`SELECT todo_read_enabled FROM mcp_preferences WHERE user_id = 'u1'`).get())
      .toEqual({ todo_read_enabled: 1 })
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
  // The Cloudflare app's rows are named by `newId()` (lib/id.ts) and every query filters on
  // `user_id`; a 26-character random id is not a name another reader can offer, so the key cannot
  // collide across accounts and the read paths never rely on it alone.
  ['cloudflare_account', 'newId() in cloudflare/accounts.ts'],
  ['cloudflare_log', 'newId() in cloudflare/audit.ts'],
  ['cloudflare_scheduled_task', 'newId() in cloudflare/tasks.ts'],
  ['cloudflare_task_execution', 'newId() in cloudflare/tasks.ts'],
  ['cloudflare_catalog_source', 'newId() in cloudflare/catalog.ts'],
  ['cloudflare_chat_session', 'newId() in cloudflare/chat-sessions.ts'],
  ['cloudflare_chat_message', 'newId() in cloudflare/chat-sessions.ts'],
  // The music cleanup queue names an R2 object under `music/.../<user_id>/...`, so the key itself
  // already carries the account and the queue is a work list rather than an account-owned record.
  ['music_cleanup', 'object key embeds the owner id'],
  // Composite, but not leading with the account: a wiki link is one edge from a note, and the source
  // note id is already `newId()`-random and account-owned, so `target_key` cannot name another
  // account's edge. Reads scope by `user_id` (idx_links_user_source).
  ['links', 'composite (source_note_id, target_key) on account-owned notes'],
  ['memos_spaces', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_items', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_reactions', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_attachments', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_shares', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_views', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_tokens', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_webhooks', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_import_sessions', 'id is a 26-character newId(); every read binds user_id'],
  ['memos_changes', 'seq INTEGER PRIMARY KEY AUTOINCREMENT, every read filters on user_id'],
  // An append-only fact row, not an account's record: the id exists so the visit log can page over a
  // window, and SQLite only autonumbers a row whose integer key is the whole primary key. Every read
  // filters on `user_id`, and the four covering indexes all lead with it or with the slug.
  ['share_visits', 'seq INTEGER PRIMARY KEY AUTOINCREMENT, every read filters on user_id'],
  ['email_group_members', 'composite (group_id, contact_id) on newId() groups and contacts; every read binds user_id'],
  ['tools_shortlinks_links', 'id INTEGER PRIMARY KEY AUTOINCREMENT, every read filters on user_id'],
  ['tools_shortlinks_slugs', 'public by slug and minted by Base62 generator; public redirect by slug alone, management binds user_id'],
  ['tools_shortlinks_clicks', 'id INTEGER PRIMARY KEY AUTOINCREMENT append-only click log; every read binds user_id'],
  ['tools_shortlinks_bundles', 'id INTEGER PRIMARY KEY AUTOINCREMENT, every read filters on user_id'],
  ['tools_shortlinks_api_keys', 'id INTEGER PRIMARY KEY AUTOINCREMENT, lookup by unique key_hash; management binds user_id'],
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
