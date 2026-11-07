// Staged SFTP uploads (plan §5.4) write chunk objects under a per-transfer prefix and are removed on
// completion or cancel. A transfer that a client abandoned — closed tab, evicted session — leaves
// those objects behind, so the hour sweep collects them.
//
// A transfer is only swept when it has been untouched for the staging window *and* its account has no
// live session row. The second check is the D1-side "is anyone still using this": every staging call
// is gated on an active session, so a live row is the one condition under which a transfer might
// still be completed. Re-running the sweep is safe; the next pass finds fewer keys, and an empty
// prefix is not an error.

import type { Env } from '../env'
import { recordAudit } from './audit'

export const WEBSSH_STAGING_UPLOAD_PREFIX = 'webssh/documents/uploads'

/** An interrupted transfer is kept this long for a client that comes back to finish it. */
export const WEBSSH_STAGING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

export const WEBSSH_STAGING_PURGE_TRANSFERS = 50

const STAGING_LIST_PAGE = 1_000
const STAGING_MAX_KEYS = 5_000
const DELETE_BATCH = 100

interface StagedTransfer {
  userId: string
  transferId: string
  keys: string[]
  oldestUpload: Date | null
}

function report(error: unknown): void {
  console.warn('[inkstone] WebSSH staging sweep failed:', (error as Error).message)
}

/** `webssh/documents/uploads/<user>/<transfer>/...` -> the pair naming that transfer. */
function transferOf(key: string): { userId: string; transferId: string } | null {
  if (!key.startsWith(`${WEBSSH_STAGING_UPLOAD_PREFIX}/`)) return null
  const segments = key.slice(WEBSSH_STAGING_UPLOAD_PREFIX.length + 1).split('/')
  if (segments.length < 2 || !segments[0] || !segments[1]) return null
  return { userId: segments[0], transferId: segments[1] }
}

async function listStagedTransfers(bucket: R2Bucket): Promise<StagedTransfer[]> {
  const groups = new Map<string, StagedTransfer>()
  let cursor: string | undefined
  let scanned = 0
  for (;;) {
    const listed = await bucket.list({ prefix: `${WEBSSH_STAGING_UPLOAD_PREFIX}/`, cursor, limit: STAGING_LIST_PAGE })
    for (const object of listed.objects) {
      scanned += 1
      const owner = transferOf(object.key)
      if (!owner) continue
      const id = `${owner.userId}/${owner.transferId}`
      const group = groups.get(id)
      if (group) {
        group.keys.push(object.key)
        if (!group.oldestUpload || object.uploaded < group.oldestUpload) group.oldestUpload = object.uploaded
      } else {
        groups.set(id, { ...owner, keys: [object.key], oldestUpload: object.uploaded })
      }
    }
    if (!listed.truncated || scanned >= STAGING_MAX_KEYS) return [...groups.values()]
    cursor = listed.cursor
  }
}

async function stagedAt(bucket: R2Bucket, transfer: StagedTransfer): Promise<number> {
  const meta = await bucket.get(`${WEBSSH_STAGING_UPLOAD_PREFIX}/${transfer.userId}/${transfer.transferId}/meta.json`)
  if (!meta) return transfer.oldestUpload ? transfer.oldestUpload.getTime() : 0
  try {
    const parsed = await meta.json<{ createdAt?: unknown }>()
    if (typeof parsed?.createdAt === 'number' && Number.isSafeInteger(parsed.createdAt) && parsed.createdAt > 0) {
      return parsed.createdAt
    }
  } catch {
    // An unreadable meta is treated like a missing one: the objects' own write time decides.
  }
  return transfer.oldestUpload ? transfer.oldestUpload.getTime() : 0
}

async function accountHasLiveSession(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM webssh_sessions
        WHERE user_id = ?1 AND status IN ('pending', 'connecting', 'active') LIMIT 1`,
    )
    .bind(userId)
    .first<{ present: number }>()
  return row?.present === 1
}

/**
 * Removes abandoned staged uploads. Answers how many transfers were swept. A missing R2 binding is
 * answered with zero rather than an error: a deployment without staging has nothing to collect.
 */
export async function purgeStagingUploads(
  env: Env,
  now: number,
  maxTransfers = WEBSSH_STAGING_PURGE_TRANSFERS,
): Promise<number> {
  if (!env.FILES) return 0
  const transfers = await listStagedTransfers(env.FILES)
  let removed = 0
  for (const transfer of transfers) {
    if (removed >= maxTransfers) break
    const startedAt = await stagedAt(env.FILES, transfer)
    if (startedAt <= 0 || now - startedAt < WEBSSH_STAGING_UPLOAD_TTL_MS) continue
    try {
      if (await accountHasLiveSession(env.DB, transfer.userId)) continue
    } catch (error) {
      report(error)
      continue
    }
    try {
      for (let index = 0; index < transfer.keys.length; index += DELETE_BATCH) {
        await env.FILES.delete(transfer.keys.slice(index, index + DELETE_BATCH))
      }
      removed += 1
    } catch (error) {
      report(error)
      await recordAudit(env.DB, {
        userId: transfer.userId,
        eventType: 'retention_fail',
        metadata: { scope: 'staging', transferId: transfer.transferId, reason: 'r2_delete' },
        now,
      }).catch(() => undefined)
    }
  }
  return removed
}
