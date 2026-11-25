/**
 * Receipts for writes carrying an `Idempotency-Key`. A key is bound to one request fingerprint and the
 * resource role that created it, so replaying it cannot repeat a write or bypass a later permission
 * change. A pending row is a short-lived claim that prevents concurrent duplicate execution.
 */
import type { ProjectRole } from '@shared/project/model'
import { sha256Hex } from '../lib/encoding'

const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PROJECT_WRITE_CLAIM_TTL_MS = 2 * 60 * 1000
const RECEIPT_VERSION = 2

export interface ProjectWriteReceipt {
  state: 'pending' | 'complete' | 'legacy'
  method: string
  path: string
  bodyHash: string
  boardId: string
  requiredRole: ProjectRole | ''
  ownerRequired: boolean
  status: number
  body: string
  createdAt: number
}

export interface ProjectWriteClaim {
  method: string
  path: string
  bodyHash: string
  boardId: string
  requiredRole: ProjectRole | ''
  ownerRequired: boolean
}

interface ReceiptEnvelope extends ProjectWriteClaim {
  version: number
  state: 'pending' | 'complete'
  responseBody: string
}

interface WriteReceiptRow {
  status: number
  body: string
  created_at: number
}

export async function projectWriteFingerprint(body: ArrayBuffer): Promise<string> {
  return sha256Hex(new Uint8Array(body))
}

function decodeEnvelope(raw: string): ReceiptEnvelope | null {
  try {
    const value = JSON.parse(raw) as Partial<ReceiptEnvelope>
    if (value.version !== RECEIPT_VERSION || (value.state !== 'pending' && value.state !== 'complete')) return null
    if (typeof value.method !== 'string' || typeof value.path !== 'string' || typeof value.bodyHash !== 'string'
      || typeof value.boardId !== 'string' || typeof value.requiredRole !== 'string'
      || typeof value.ownerRequired !== 'boolean' || typeof value.responseBody !== 'string') return null
    return value as ReceiptEnvelope
  } catch {
    return null
  }
}

export async function readProjectWriteReceipt(
  db: D1Database, userId: string, key: string,
): Promise<ProjectWriteReceipt | null> {
  const row = await db.prepare(
    'SELECT status, body, created_at FROM project_write_receipts WHERE user_id = ?1 AND key = ?2',
  ).bind(userId, key).first<WriteReceiptRow>()
  if (!row) return null
  const envelope = decodeEnvelope(row.body)
  if (!envelope) {
    return {
      state: 'legacy', method: '', path: '', bodyHash: '', boardId: '', requiredRole: '',
      ownerRequired: false, status: row.status, body: row.body, createdAt: row.created_at,
    }
  }
  return {
    state: envelope.state,
    method: envelope.method,
    path: envelope.path,
    bodyHash: envelope.bodyHash,
    boardId: envelope.boardId,
    requiredRole: envelope.requiredRole as ProjectRole | '',
    ownerRequired: envelope.ownerRequired,
    status: row.status,
    body: envelope.responseBody,
    createdAt: row.created_at,
  }
}

export async function claimProjectWriteReceipt(
  db: D1Database, userId: string, key: string, claim: ProjectWriteClaim, now: number,
): Promise<boolean> {
  const envelope: ReceiptEnvelope = { ...claim, version: RECEIPT_VERSION, state: 'pending', responseBody: '' }
  const result = await db.prepare(
    `INSERT INTO project_write_receipts (user_id, key, status, body, created_at) VALUES (?1, ?2, 0, ?3, ?4)
     ON CONFLICT(user_id, key) DO NOTHING`,
  ).bind(userId, key, JSON.stringify(envelope), now).run()
  return (result.meta?.changes ?? 0) > 0
}

export async function completeProjectWriteReceipt(
  db: D1Database, userId: string, key: string, status: number, body: string, now: number,
): Promise<void> {
  const current = await readProjectWriteReceipt(db, userId, key)
  if (!current || current.state !== 'pending') return
  const envelope: ReceiptEnvelope = {
    version: RECEIPT_VERSION,
    state: 'complete',
    method: current.method,
    path: current.path,
    bodyHash: current.bodyHash,
    boardId: current.boardId,
    requiredRole: current.requiredRole,
    ownerRequired: current.ownerRequired,
    responseBody: body,
  }
  await db.prepare(
    `UPDATE project_write_receipts SET status = ?3, body = ?4, created_at = ?5
     WHERE user_id = ?1 AND key = ?2 AND status = 0`,
  ).bind(userId, key, status, JSON.stringify(envelope), now).run()
}

export async function discardProjectWriteReceipt(db: D1Database, userId: string, key: string): Promise<void> {
  await db.prepare('DELETE FROM project_write_receipts WHERE user_id = ?1 AND key = ?2').bind(userId, key).run()
}

export async function pruneProjectWriteReceipts(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM project_write_receipts WHERE created_at < ?1')
    .bind(now - RECEIPT_TTL_MS).run()
  return result.meta?.changes ?? 0
}
