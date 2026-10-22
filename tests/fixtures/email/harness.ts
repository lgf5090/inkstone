import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_STATEMENTS } from '../../../src/worker/db/schema'
import { applyMailboxMigrations } from '../../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../../src/worker/email/mailbox-store'
import { makeD1 } from '../../doubles/d1-sqlite'
import { makeSqlExec } from '../../doubles/do-sqlite'

class HarnessMailbox {
  readonly sqlite = new DatabaseSync(':memory:')
  readonly store: MailboxStore

  constructor() {
    const sql = makeSqlExec(this.sqlite)
    applyMailboxMigrations(sql)
    this.store = new MailboxStore(sql)
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
  const stub = (mailbox: HarnessMailbox) => ({
    async claimInbound(messageKey: string, now?: number) {
      return mailbox.store.claimInbound(messageKey, now)
    },
    async completeInbound(messageKey: string) {
      mailbox.store.completeInbound(messageKey)
    },
    async releaseInbound(messageKey: string) {
      mailbox.store.releaseInbound(messageKey)
    },
    async createEmail(folder: string, email: Parameters<MailboxStore['createEmail']>[1]) {
      return mailbox.store.createEmail(folder, email)
    },
    async findThreadBySubject(subject: string, sender?: string) {
      return mailbox.store.findThreadBySubject(subject, sender)
    },
    async purgeExpiredTrash(cutoff: number) {
      return mailbox.store.purgeExpiredTrash(cutoff)
    },
    async deleteEmail(id: string) {
      return mailbox.store.deleteEmail(id)
    },
  })
  const namespace = {
    idFromName: (name: string) => objectId(name),
    get: (id: DurableObjectId) => stub(box(id.name ?? id.toString())),
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
