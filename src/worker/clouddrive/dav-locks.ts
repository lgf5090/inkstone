/**
 * WebDAV write locks (RFC 4918 §6.4).
 *
 * A lock is a claim on one path: the holder says it intends to write there, and every mutating
 * DAV method has to honour that claim. Rows carry their own expiry and are compared against the
 * clock on read, so a client that disappears mid-edit stops blocking the drive once its timeout
 * runs out rather than leaving a permanent door held shut.
 */

export type DavLockScope = 'exclusive' | 'shared'
export type DavLockDepth = '0' | 'infinity'

export interface DavLock {
  token: string
  root: string
  scope: DavLockScope
  depth: DavLockDepth
  owner: string
  expiresAt: number
}

interface LockRow {
  token: string
  root: string
  scope: string
  depth: string
  owner: string
  expires_at: number
}

const LOCK_TOKEN_PREFIX = 'opaquelocktoken:'
const DEFAULT_LOCK_SECONDS = 3600
const MIN_LOCK_SECONDS = 15
const MAX_LOCK_SECONDS = 7 * 24 * 60 * 60
const MAX_OWNER_CHARS = 200
const MAX_LOCKS_PER_MOUNT = 200

/** Whether a lock written against `lock.root` reaches `path`. */
export function lockCovers(lock: DavLock, path: string): boolean {
  if (lock.depth === '0') return lock.root === path
  return path === lock.root || path.startsWith(lock.root === '/' ? '/' : `${lock.root}/`)
}

/** The body of a `LOCK` that creates a lock; an empty body means the client is refreshing. */
export function isLockRequest(xml: string): boolean {
  return /<(?:[A-Za-z0-9_-]+:)?lockinfo\b/i.test(xml)
}

export function parseLockScope(xml: string): DavLockScope {
  return /<(?:[A-Za-z0-9_-]+:)?shared\b/i.test(xml) ? 'shared' : 'exclusive'
}

/** `Depth: 0` locks one resource; anything else, including a missing header, locks the subtree. */
export function parseLockDepth(header: string | undefined): DavLockDepth {
  return (header ?? 'infinity').trim().toLowerCase() === '0' ? '0' : 'infinity'
}

/** `<D:owner>` is free-form and may nest `<D:href>`; the text inside it is what a client shows. */
export function parseLockOwner(xml: string): string {
  const match = xml.match(/<(?:[A-Za-z0-9_-]+:)?owner\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?owner>/i)
  if (!match) return ''
  const text = match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_OWNER_CHARS)
}

/** `Timeout: Second-120`; anything unreadable or out of range falls back to the default. */
export function parseLockTimeoutSeconds(header: string | undefined): number {
  const match = (header ?? '').match(/Second-(\d{1,10})/i)
  if (!match) return DEFAULT_LOCK_SECONDS
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds < MIN_LOCK_SECONDS) return MIN_LOCK_SECONDS
  return Math.min(seconds, MAX_LOCK_SECONDS)
}

/**
 * Tokens the client actually holds, read from `Lock-Token` and `If`.
 *
 * An `If` header we cannot fully evaluate — one carrying a `No`/`Not` condition or a literal — is
 * treated as presenting nothing, because guessing at it would hand a lock to a client that did not
 * prove it holds the token.
 */
export function presentedLockTokens(ifHeader: string | undefined, lockTokenHeader: string | undefined): string[] {
  const tokens = new Set<string>()
  for (const header of [ifHeader, lockTokenHeader]) {
    if (!header) continue
    if (/(?:^|[\s(])(?:No|Not)\s/i.test(header)) continue
    for (const match of header.matchAll(/<([^<>]+)>/g)) {
      const value = match[1].trim()
      if (value.startsWith(LOCK_TOKEN_PREFIX)) tokens.add(value)
    }
  }
  return [...tokens]
}

export function newLockToken(): string {
  return `${LOCK_TOKEN_PREFIX}${crypto.randomUUID()}`
}

function toLock(row: LockRow): DavLock {
  return {
    token: row.token,
    root: row.root,
    scope: row.scope === 'shared' ? 'shared' : 'exclusive',
    depth: row.depth === '0' ? '0' : 'infinity',
    owner: row.owner,
    expiresAt: row.expires_at,
  }
}

/** Every lock still alive on one mount. Locks are rare, so one small read beats a per-path query. */
export async function activeLocks(
  db: D1Database,
  userId: string,
  mountId: string,
  now: number,
): Promise<DavLock[]> {
  const { results } = await db.prepare(
    `SELECT token, root, scope, depth, owner, expires_at
       FROM CloudDrive_dav_locks
      WHERE user_id = ?1 AND mount_id = ?2 AND expires_at > ?3
      ORDER BY created_at, token
      LIMIT ${MAX_LOCKS_PER_MOUNT}`,
  ).bind(userId, mountId, now).all<LockRow>()
  return (results ?? []).map(toLock)
}

/** Drop this mount's dead locks. Called on the ways in, so the table cannot grow without bound. */
export async function sweepExpiredLocks(
  db: D1Database,
  userId: string,
  mountId: string,
  now: number,
): Promise<void> {
  await db.prepare(
    'DELETE FROM CloudDrive_dav_locks WHERE user_id = ?1 AND mount_id = ?2 AND expires_at <= ?3',
  ).bind(userId, mountId, now).run()
}

/**
 * The answer to a `LOCK`: the lock that was taken, or the one already in the way.
 *
 * An exclusive lock conflicts with anything covering the same path; a shared lock only conflicts
 * with an exclusive one, which is what lets several readers open the same document.
 */
export type LockOutcome =
  | { status: 'created'; lock: DavLock }
  | { status: 'conflict'; heldBy: DavLock }
  | { status: 'limit' }

export async function createLock(input: {
  db: D1Database
  userId: string
  mountId: string
  root: string
  scope: DavLockScope
  depth: DavLockDepth
  owner: string
  seconds: number
  now: number
  tokens: string[]
}): Promise<LockOutcome> {
  const existing = await activeLocks(input.db, input.userId, input.mountId, input.now)
  if (existing.length >= MAX_LOCKS_PER_MOUNT) return { status: 'limit' }
  const covering = existing.filter((lock) => lockCovers(lock, input.root))
  const heldByOthers = covering.filter((lock) => !input.tokens.includes(lock.token))
  const blocking = input.scope === 'exclusive'
    ? heldByOthers[0]
    : heldByOthers.find((lock) => lock.scope === 'exclusive')
  if (blocking) return { status: 'conflict', heldBy: blocking }
  const lock: DavLock = {
    token: newLockToken(),
    root: input.root,
    scope: input.scope,
    depth: input.depth,
    owner: input.owner,
    expiresAt: input.now + input.seconds * 1000,
  }
  await input.db.prepare(
    `INSERT INTO CloudDrive_dav_locks (token, user_id, mount_id, root, scope, depth, owner, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    lock.token, input.userId, input.mountId, lock.root, lock.scope, lock.depth, lock.owner, lock.expiresAt, input.now,
  ).run()
  return { status: 'created', lock }
}

/** Extend the lock a client already holds. Returns null when that token is not held here. */
export async function refreshLock(input: {
  db: D1Database
  userId: string
  mountId: string
  root: string
  token: string
  seconds: number
  now: number
}): Promise<DavLock | null> {
  const existing = await activeLocks(input.db, input.userId, input.mountId, input.now)
  const lock = existing.find((one) => one.token === input.token && lockCovers(one, input.root))
  if (!lock) return null
  const expiresAt = input.now + input.seconds * 1000
  await input.db.prepare('UPDATE CloudDrive_dav_locks SET expires_at = ?1 WHERE user_id = ?2 AND token = ?3')
    .bind(expiresAt, input.userId, lock.token).run()
  return { ...lock, expiresAt }
}

/** Release a lock. Returns false when no live lock on this path carries that token. */
export async function releaseLock(input: {
  db: D1Database
  userId: string
  mountId: string
  root: string
  token: string
  now: number
}): Promise<boolean> {
  const existing = await activeLocks(input.db, input.userId, input.mountId, input.now)
  const lock = existing.find((one) => one.token === input.token && one.root === input.root)
  if (!lock) return false
  await input.db.prepare('DELETE FROM CloudDrive_dav_locks WHERE user_id = ?1 AND token = ?2')
    .bind(input.userId, lock.token).run()
  return true
}

/**
 * The lock that stands between a client and a write, or null when the path is open.
 *
 * Every covering lock has to be accounted for: a write that carries one token but sits under two
 * locks still belongs to somebody else.
 */
export async function blockingLock(input: {
  db: D1Database
  userId: string
  mountId: string
  path: string
  tokens: string[]
  now: number
}): Promise<DavLock | null> {
  const existing = await activeLocks(input.db, input.userId, input.mountId, input.now)
  return existing.find((lock) => lockCovers(lock, input.path) && !input.tokens.includes(lock.token)) ?? null
}
