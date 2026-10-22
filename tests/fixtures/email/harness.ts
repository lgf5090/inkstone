import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_STATEMENTS } from '../../../src/worker/db/schema'
import { applyMailboxMigrations } from '../../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../../src/worker/email/mailbox-store'
import { makeD1 } from '../../doubles/d1-sqlite'
import { makeSqlExec } from '../../doubles/do-sqlite'
import { fakeEmailMailboxNamespace } from '../../doubles/email-mailbox'

class HarnessMailbox {
  readonly sqlite = new DatabaseSync(':memory:')
  readonly store: MailboxStore
  readonly namespace: DurableObjectNamespace

  constructor() {
    const sql = makeSqlExec(this.sqlite)
    applyMailboxMigrations(sql)
    this.store = new MailboxStore(sql)
    this.namespace = fakeEmailMailboxNamespace(this.store)
  }
}

export interface MailboxHarness {
  namespace: DurableObjectNamespace
  store(accountId: string): MailboxStore
  sqlite(accountId: string): DatabaseSync
}

export function mailboxHarness(): MailboxHarness {
  const boxes = new Map<string, HarnessMailbox>()
  const box = (accountId: string): HarnessMailbox => {
    let found = boxes.get(accountId)
    if (!found) {
      found = new HarnessMailbox()
      boxes.set(accountId, found)
    }
    return found
  }
  const objectId = (name: string): DurableObjectId => ({
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
    name,
  }) as unknown as DurableObjectId
  const namespace: DurableObjectNamespace = {
    newUniqueId: () => objectId('unique'),
    idFromName: (name: string) => objectId(name),
    idFromString: (id: string) => objectId(id),
    get: (id: DurableObjectId) => box(id.name ?? id.toString()).namespace.get(id),
    getByName: (name: string) => box(name).namespace.get(objectId(name)),
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace
  return {
    namespace,
    store: (accountId: string) => box(accountId).store,
    sqlite: (accountId: string) => box(accountId).sqlite,
  }
}

export interface TestDatabase {
  sqlite: DatabaseSync
  db: D1Database
}

export function testDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  return { sqlite, db: makeD1(sqlite) }
}

export function seedUser(sqlite: DatabaseSync, id: string, role: 'owner' | 'member' = 'owner'): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?1, ?1, 'hash', ?1, ?1, '', ?2, '{}', ?3, ?3)`,
  ).run(id, role, now)
}
