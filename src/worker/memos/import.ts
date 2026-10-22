import {
  MEMO_ATTACHMENT_MAX_BYTES,
  MEMO_CONTENT_MAX_BYTES,
  MEMO_IMPORT_CHUNK_BYTES,
  MEMO_IMPORT_CONTENT_MAX_BYTES,
  MEMO_IMPORT_EXPANDED_MAX_BYTES,
  MEMO_IMPORT_EXPANSION_RATIO,
  MEMO_IMPORT_MANIFEST_MAX_BYTES,
  MEMO_IMPORT_MAX_ENTRIES,
  MEMO_IMPORT_RECORD_MAX_BYTES,
  MEMO_IMPORT_SESSION_TTL_MS,
} from '@shared/memos/constants'
import {
  MEMO_EXPORT_MANIFEST_ENTRY,
  MEMO_EXPORT_MAX_TOTAL_BYTES,
  MemoExportFormatError,
  isMemoExportEntryPath,
  isMemoExportMediaType,
  isMemoExportSha256,
  isMemoExportTimestamp,
  isMemoExportUid,
  parseMemoExportManifest,
  type MemoExportManifest,
} from '@shared/memos/export'
import type {
  MemoImportConflictPolicy,
  MemoImportIssue,
  MemoImportPlan,
  MemoImportReport,
  MemoImportSession,
  MemoLocation,
  MemoState,
  MemoVisibility,
} from '@shared/memos/types'
import { utf8ByteLength } from '@shared/text-utils'
import { unzipSync, type Unzipped } from 'fflate'
import type { Env } from '../env'
import {
  deleteAttachmentObjects,
  hasAttachmentStorage,
  putAttachmentObject,
  readAttachmentObject,
  selectAttachmentStorage,
  type AttachmentObjectStorage,
} from '../attachments'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import {
  MemoAttachmentError,
  deleteMemoAttachments,
  saveMemoAttachment,
} from './attachments'
import { createMemo, patchMemo } from './store/mutations'

const ARCHIVE_MAX_BYTES = MEMO_EXPORT_MAX_TOTAL_BYTES
const RATIO_FLOOR_BYTES = 64 * 1024
const MAX_ISSUES = 100
const SESSION_ID_ATTEMPTS = 5
const ID_ATTEMPTS = 5
const LOOKUP_CHUNK = 90
const STATEMENT_CHUNK = 90
const SESSION_TTL_SECONDS = MEMO_IMPORT_SESSION_TTL_MS / 1000
const RECORD_NAME_PATTERN = /^memos\/([^/]+)\.json$/
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export type MemoImportErrorCode =
  | 'memo_import_invalid'
  | 'memo_import_too_large'
  | 'memo_import_conflict'
  | 'storage_unavailable'

export class MemoImportError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 503,
    readonly code: MemoImportErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MemoImportError'
  }
}

interface ImportSessionRow {
  id: string
  user_id: string
  filename: string
  total_size: number
  received: number
  storage_key: string
  created_at: number
  expires_at: number
}

interface MemoRowInfo {
  id: string
  user_id: string
  parent_id: string | null
  state: MemoState
  rev: number
}

interface AttachmentRowInfo {
  id: string
  user_id: string
  memo_id: string | null
  filename: string
  mime: string
  size: number
  storage: AttachmentObjectStorage
  storage_key: string
}

interface ImportedAttachment {
  uid: string
  filename: string
  mime: string
  size: number
  createTime: number
  sha256: string | null
  bytes: Uint8Array | null
  external: boolean
}

interface ImportedMemo {
  uid: string
  createTime: number
  updateTime: number
  state: MemoState
  visibility: MemoVisibility
  pinned: boolean
  contentPath: string
  content: string
  location: MemoLocation | null
  space: { uid: string; title: string | null } | null
  parent: string | null
  relations: string[]
  attachments: ImportedAttachment[]
}

interface ParsedArchive {
  manifest: MemoExportManifest
  memos: ImportedMemo[]
  attachmentCount: number
  warnings: IssueLog
}

interface ImportedTarget {
  id: string
  state: MemoState
  parentId: string | null
}

interface PreparedAttachments {
  ids: string[]
  createdIds: string[]
  failure: MemoImportIssue | null
}

interface RelationPlan {
  uid: string
  memoId: string
  related: string[]
  replace: boolean
}

class IssueLog {
  private readonly items: MemoImportIssue[] = []
  private dropped = 0

  add(issue: MemoImportIssue): void {
    if (this.items.length < MAX_ISSUES) this.items.push(issue)
    else this.dropped += 1
  }

  finish(): MemoImportIssue[] {
    if (!this.dropped) return [...this.items]
    return [
      ...this.items,
      { code: 'too_many_issues', message: `${this.dropped} more issues were not listed` },
    ]
  }
}

export async function createMemoImportSession(
  env: Env,
  userId: string,
  input: { filename?: unknown; totalSize?: unknown },
): Promise<MemoImportSession> {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  if (!filename || filename.length > 255 || /[\u0000-\u001f]/.test(filename)) {
    throw new MemoImportError(400, 'memo_import_invalid', 'filename must be a non-empty string of at most 255 characters')
  }
  const totalSize = input.totalSize
  if (typeof totalSize !== 'number' || !Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new MemoImportError(400, 'memo_import_invalid', 'totalSize must be a positive integer')
  }
  if (totalSize > ARCHIVE_MAX_BYTES) {
    throw new MemoImportError(
      413,
      'memo_import_too_large',
      `The archive exceeds the ${ARCHIVE_MAX_BYTES} byte limit`,
    )
  }
  if (!selectAttachmentStorage(env)) {
    throw new MemoImportError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before importing.',
    )
  }

  const now = nowSeconds()
  await purgeExpiredSessions(env, userId, now)

  for (let attempt = 0; attempt < SESSION_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const storageKey = stagingKey(userId, id)
    const expiresAt = now + SESSION_TTL_SECONDS
    const { meta } = await env.DB.prepare(
      `INSERT OR IGNORE INTO memos_import_sessions (
         id, user_id, filename, total_size, received, storage_key, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)`,
    )
      .bind(id, userId, filename, totalSize, storageKey, now, expiresAt)
      .run()
    if (meta.changes) {
      return { id, filename, totalSize, received: 0, chunkSize: MEMO_IMPORT_CHUNK_BYTES, expiresAt }
    }
  }
  throw ApiError.conflict('Could not create an import session. Try again')
}

export async function appendMemoImportChunk(
  env: Env,
  userId: string,
  sessionId: string,
  offset: number,
  bytes: Uint8Array,
): Promise<{ received: number }> {
  const session = await loadActiveSession(env, userId, sessionId)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new MemoImportError(400, 'memo_import_invalid', 'The chunk offset must be a non-negative integer')
  }
  if (bytes.byteLength === 0) {
    throw new MemoImportError(400, 'memo_import_invalid', 'The chunk must not be empty')
  }
  if (bytes.byteLength > MEMO_IMPORT_CHUNK_BYTES) {
    throw new MemoImportError(
      413,
      'memo_import_too_large',
      `Each chunk must be at most ${MEMO_IMPORT_CHUNK_BYTES} bytes`,
    )
  }

  const received = Number(session.received)
  const totalSize = Number(session.total_size)
  const end = offset + bytes.byteLength
  if (offset < received && end <= received) return { received }
  if (offset !== received) {
    throw new MemoImportError(
      409,
      'memo_import_conflict',
      `The upload offset ${offset} does not match the expected offset ${received}`,
      { expectedOffset: received, received },
    )
  }
  if (end > totalSize) {
    throw new MemoImportError(
      413,
      'memo_import_too_large',
      'The chunk extends past the declared archive size',
    )
  }
  if (end < totalSize && bytes.byteLength !== MEMO_IMPORT_CHUNK_BYTES) {
    throw new MemoImportError(
      400,
      'memo_import_invalid',
      `Every chunk except the last must be ${MEMO_IMPORT_CHUNK_BYTES} bytes`,
    )
  }

  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new MemoImportError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before importing.',
    )
  }
  await putAttachmentObject(env, storage, stagedPartKey(session.storage_key, offset), bytes, {
    userId,
    objectId: session.id,
    kind: 'import',
    filename: session.filename,
    mime: 'application/zip',
    sha256: await sha256Hex(bytes),
  })

  const expiresAt = nowSeconds() + SESSION_TTL_SECONDS
  const { meta } = await env.DB.prepare(
    `UPDATE memos_import_sessions
        SET received = ?1, expires_at = ?2
      WHERE id = ?3 AND user_id = ?4 AND received = ?5`,
  )
    .bind(end, expiresAt, session.id, userId, offset)
    .run()
  if (meta.changes) return { received: end }

  const latest = await env.DB.prepare(
    'SELECT received FROM memos_import_sessions WHERE id = ?1 AND user_id = ?2',
  )
    .bind(session.id, userId)
    .first<{ received: number }>()
  if (!latest) throw ApiError.notFound('Import session not found or expired')
  if (Number(latest.received) === end) return { received: end }
  throw new MemoImportError(
    409,
    'memo_import_conflict',
    'The upload offset changed while the chunk was stored',
    { expectedOffset: Number(latest.received), received: Number(latest.received) },
  )
}

export async function buildMemoImportPlan(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<MemoImportPlan> {
  const session = await loadActiveSession(env, userId, sessionId)
  const archive = await readArchive(env, session)
  const memoRows = await loadMemoRows(env.DB, archive.memos.map((memo) => memo.uid))

  let newCount = 0
  let existingCount = 0
  let renamedCount = 0
  for (const memo of archive.memos) {
    const row = memoRows.get(memo.uid)
    if (!row) newCount += 1
    else if (row.user_id === userId) existingCount += 1
    else renamedCount += 1
  }

  return {
    exporter: archive.manifest.scope.user.username,
    exportTime: unixSeconds(archive.manifest.exportTime),
    memoCount: archive.memos.length,
    attachmentCount: archive.attachmentCount,
    newCount,
    renamedCount,
    existingCount,
    warnings: archive.warnings.finish(),
  }
}

export async function commitMemoImport(
  env: Env,
  userId: string,
  sessionId: string,
  policyInput: unknown,
): Promise<MemoImportReport> {
  const policy = parsePolicy(policyInput)
  const session = await loadActiveSession(env, userId, sessionId)
  const archive = await readArchive(env, session)
  const warnings = archive.warnings
  const failures = new IssueLog()
  let failed = 0
  const fail = (issue: MemoImportIssue): void => {
    failed += 1
    failures.add(issue)
  }

  const archiveByUid = new Map(archive.memos.map((memo) => [memo.uid, memo]))
  const memoRows = await loadMemoRows(env.DB, archive.memos.map((memo) => memo.uid))
  const attachmentRows = await loadAttachmentRows(
    env.DB,
    archive.memos.flatMap((memo) => memo.attachments.map((attachment) => attachment.uid)),
  )
  const externalIds = new Set<string>()
  for (const memo of archive.memos) {
    if (memo.parent && !archiveByUid.has(memo.parent)) externalIds.add(memo.parent)
    for (const relation of memo.relations) {
      if (!archiveByUid.has(relation)) externalIds.add(relation)
    }
  }
  const externalRows = await loadMemoRows(env.DB, [...externalIds])
  const spaces = new ImportSpaceResolver(env.DB, userId)
  const targets = new Map<string, ImportedTarget>()
  const relations: RelationPlan[] = []

  let created = 0
  let updated = 0
  let skipped = 0

  for (const memo of orderedMemos(archive.memos)) {
    const existing = memoRows.get(memo.uid)
    const own = existing && existing.user_id === userId ? existing : null
    let action: 'create' | 'replace' | 'skip'
    let targetId: string
    if (own) {
      action = policy === 'skip' ? 'skip' : policy === 'replace' ? 'replace' : 'create'
      targetId = action === 'create' ? await newMemoId(env.DB) : own.id
    } else if (existing) {
      action = 'create'
      targetId = await newMemoId(env.DB)
    } else {
      action = 'create'
      targetId = isValidId(memo.uid) ? memo.uid : await newMemoId(env.DB)
    }

    if (action === 'skip' && own) {
      skipped += 1
      targets.set(memo.uid, { id: own.id, state: own.state, parentId: own.parent_id })
      continue
    }

    if (utf8ByteLength(memo.content) > MEMO_CONTENT_MAX_BYTES) {
      fail({
        code: 'content_too_large',
        path: recordPath(memo),
        message: `Memo ${memo.uid} exceeds the ${MEMO_CONTENT_MAX_BYTES} byte content limit`,
      })
      continue
    }

    const parentId = resolveMemoParent(memo, archiveByUid, targets, externalRows, userId, warnings)
    const prepared = await prepareAttachments(env, userId, memo, targetId, attachmentRows, warnings)
    if (prepared.failure) {
      fail(prepared.failure)
      continue
    }

    const spaceId = memo.space ? await spaces.resolve(memo.space) : null

    if (action === 'replace' && own) {
      try {
        const boundAttachments = await currentAttachmentIds(env.DB, userId, own.id)
        const result = await patchMemo(env.DB, userId, own.id, {
          rev: own.rev,
          content: memo.content,
          visibility: memo.visibility,
          spaceId,
          pinned: memo.pinned,
          state: memo.state,
          location: memo.location,
          attachmentIds: [...new Set([...boundAttachments, ...prepared.ids])],
          createdAt: memo.createTime,
          updatedAt: memo.updateTime,
        })
        if (result.status === 'updated') {
          updated += 1
          targets.set(memo.uid, { id: own.id, state: memo.state, parentId: own.parent_id })
          relations.push({ uid: memo.uid, memoId: own.id, related: memo.relations, replace: true })
        } else {
          await discardCreatedAttachments(env, userId, prepared.createdIds)
          fail({
            code: result.status === 'conflict' ? 'replace_conflict' : 'replace_missing',
            path: recordPath(memo),
            message: result.status === 'conflict'
              ? `Memo ${memo.uid} changed while it was being replaced`
              : `Memo ${memo.uid} no longer exists`,
          })
        }
      } catch (error) {
        await discardCreatedAttachments(env, userId, prepared.createdIds)
        if (error instanceof ApiError && (error.status === 400 || error.status === 413 || error.status === 415)) {
          fail({ code: 'replace_failed', path: recordPath(memo), message: error.message })
        } else {
          throw error
        }
      }
      continue
    }

    try {
      const memoRecord = await createMemoWithRetry(env.DB, userId, memo, targetId, parentId, spaceId, prepared.ids)
      if (memo.pinned || memo.state === 'archived') {
        const finalized = await patchMemo(env.DB, userId, memoRecord.id, {
          rev: memoRecord.rev,
          pinned: memo.pinned,
          state: memo.state,
          updatedAt: memo.updateTime,
        })
        if (finalized.status !== 'updated') {
          warnings.add({
            code: 'state_not_applied',
            path: recordPath(memo),
            message: `Memo ${memo.uid} was imported without its archived or pinned state`,
          })
        }
      }
      created += 1
      targets.set(memo.uid, { id: memoRecord.id, state: memo.state, parentId })
      relations.push({ uid: memo.uid, memoId: memoRecord.id, related: memo.relations, replace: false })
    } catch (error) {
      await discardCreatedAttachments(env, userId, prepared.createdIds)
      if (error instanceof ApiError && (error.status === 400 || error.status === 409 || error.status === 413 || error.status === 415)) {
        fail({ code: 'create_failed', path: recordPath(memo), message: error.message })
      } else {
        throw error
      }
    }
  }

  for (const plan of relations) {
    const resolved: string[] = []
    for (const related of plan.related) {
      const target = targets.get(related)
      const external = externalRows.get(related)
      const targetId = target?.id ?? (external && external.user_id === userId ? external.id : null)
      if (!targetId) {
        warnings.add({
          code: 'relation_missing',
          path: `memos/${plan.uid}.json`,
          message: `Related memo ${related} was not imported`,
        })
        continue
      }
      if (targetId === plan.memoId || resolved.includes(targetId)) continue
      resolved.push(targetId)
    }
    await writeRelations(env.DB, plan.memoId, resolved, plan.replace)
  }

  try {
    await removeSession(env, session)
  } catch (error) {
    console.warn('[inkstone] The imported archive could not be removed from staging:', error)
  }

  return {
    created,
    updated,
    skipped,
    failed,
    failures: failures.finish(),
    warnings: warnings.finish(),
  }
}

export async function cancelMemoImportSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  if (!isValidId(sessionId)) throw ApiError.notFound('Import session not found')
  const session = await env.DB.prepare(
    `SELECT id, user_id, filename, total_size, received, storage_key, created_at, expires_at
       FROM memos_import_sessions
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<ImportSessionRow>()
  if (!session) throw ApiError.notFound('Import session not found')
  await removeSession(env, session)
}

function parsePolicy(value: unknown): MemoImportConflictPolicy {
  if (value === undefined || value === null) return 'skip'
  if (value === 'skip' || value === 'replace' || value === 'duplicate') return value
  throw new MemoImportError(400, 'memo_import_invalid', 'conflictPolicy must be skip, replace, or duplicate')
}

async function loadActiveSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<ImportSessionRow> {
  if (!isValidId(sessionId)) throw ApiError.notFound('Import session not found or expired')
  const session = await env.DB.prepare(
    `SELECT id, user_id, filename, total_size, received, storage_key, created_at, expires_at
       FROM memos_import_sessions
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<ImportSessionRow>()
  if (!session) throw ApiError.notFound('Import session not found or expired')
  if (Number(session.expires_at) <= nowSeconds()) {
    try {
      await removeSession(env, session)
    } catch (error) {
      console.warn('[inkstone] An expired import session could not be cleaned up:', error)
    }
    throw ApiError.notFound('Import session not found or expired')
  }
  return session
}

async function purgeExpiredSessions(env: Env, userId: string, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `DELETE FROM memos_import_sessions
      WHERE user_id = ?1 AND expires_at <= ?2
      RETURNING id, user_id, filename, total_size, received, storage_key, created_at, expires_at`,
  )
    .bind(userId, now)
    .all<ImportSessionRow>()
  for (const session of results) {
    try {
      await deleteSessionObjects(env, session)
    } catch (error) {
      console.warn('[inkstone] Expired import staging could not be removed:', error)
    }
  }
}

async function removeSession(env: Env, session: ImportSessionRow): Promise<void> {
  await env.DB.prepare('DELETE FROM memos_import_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(session.id, session.user_id)
    .run()
  await deleteSessionObjects(env, session)
}

async function deleteSessionObjects(env: Env, session: ImportSessionRow): Promise<void> {
  const storage = selectAttachmentStorage(env)
  if (!storage) return
  const keys: string[] = []
  for (let offset = 0; offset <= Number(session.received); offset += MEMO_IMPORT_CHUNK_BYTES) {
    keys.push(stagedPartKey(session.storage_key, offset))
  }
  await deleteAttachmentObjects(env, storage, keys)
}

function stagingKey(userId: string, sessionId: string): string {
  return `memo-import/${userId}/${sessionId}`
}

function stagedPartKey(storageKey: string, offset: number): string {
  return `${storageKey}/${offset}`
}

async function readArchive(env: Env, session: ImportSessionRow): Promise<ParsedArchive> {
  return parseArchive(await readStagedArchive(env, session))
}

async function readStagedArchive(env: Env, session: ImportSessionRow): Promise<Uint8Array> {
  const received = Number(session.received)
  const totalSize = Number(session.total_size)
  if (received !== totalSize) {
    throw new MemoImportError(
      409,
      'memo_import_conflict',
      `The upload is incomplete: received ${received} of ${totalSize} bytes`,
      { received, totalSize },
    )
  }
  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new MemoImportError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before importing.',
    )
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  while (offset < received) {
    const length = Math.min(MEMO_IMPORT_CHUNK_BYTES, received - offset)
    const part = await readAttachmentObject(env, storage, stagedPartKey(session.storage_key, offset))
    if (!part || part.byteLength !== length) {
      throw new ApiError(500, 'internal', 'The staged upload is incomplete')
    }
    bytes.set(part, offset)
    offset += length
  }
  return bytes
}

function parseArchive(bytes: Uint8Array): ParsedArchive {
  const warnings = new IssueLog()
  const entries = unzipEntries(bytes)
  const manifest = parseManifest(entries)
  const memos: ImportedMemo[] = []
  const attachmentUids = new Set<string>()

  for (const name of Object.keys(entries)) {
    const match = RECORD_NAME_PATTERN.exec(name)
    if (!match) continue
    const expectedUid = match[1] ?? ''
    const record = parseMemoRecord(jsonEntry(entries, name, MEMO_IMPORT_RECORD_MAX_BYTES), name, entries, warnings)
    if (record.uid !== expectedUid) {
      throw invalid(`Memo record ${name} must use the memo UID as its file name`)
    }
    for (const attachment of record.attachments) {
      if (attachmentUids.has(attachment.uid)) {
        throw invalid(`Attachment ${attachment.uid} is referenced more than once`)
      }
      attachmentUids.add(attachment.uid)
    }
    memos.push(record)
  }

  const attachmentCount = memos.reduce(
    (total, memo) => total + memo.attachments.filter((attachment) => !attachment.external).length,
    0,
  )
  if (manifest.counts?.memos !== undefined && manifest.counts.memos !== memos.length) {
    warnings.add({
      code: 'manifest_count_mismatch',
      path: MEMO_EXPORT_MANIFEST_ENTRY,
      message: `The manifest counts ${manifest.counts.memos} memos but the archive holds ${memos.length}`,
    })
  }
  if (manifest.counts?.attachments !== undefined && manifest.counts.attachments !== attachmentCount) {
    warnings.add({
      code: 'manifest_count_mismatch',
      path: MEMO_EXPORT_MANIFEST_ENTRY,
      message: `The manifest counts ${manifest.counts.attachments} attachments but the archive holds ${attachmentCount}`,
    })
  }

  return { manifest, memos, attachmentCount, warnings }
}

function unzipEntries(bytes: Uint8Array): Unzipped {
  let entries = 0
  let expandedTotal = 0
  let compressedTotal = 0
  const names = new Set<string>()
  try {
    const result = unzipSync(bytes, {
      filter: (file) => {
        entries += 1
        if (entries > MEMO_IMPORT_MAX_ENTRIES) {
          throw tooLarge(`The archive holds more than ${MEMO_IMPORT_MAX_ENTRIES} entries`)
        }
        const directory = file.name.endsWith('/')
        const name = directory ? file.name.slice(0, -1) : file.name
        if (!name || !isMemoExportEntryPath(name)) {
          throw invalid(`Unsafe archive entry name: ${file.name}`)
        }
        if (names.has(file.name)) throw invalid(`Duplicate archive entry name: ${file.name}`)
        names.add(file.name)
        if (file.compression !== 0 && file.compression !== 8) {
          throw invalid(`Unsupported compression method ${file.compression} in ${file.name}`)
        }
        checkEntrySize(file.name, file.originalSize)
        expandedTotal += file.originalSize
        if (expandedTotal > MEMO_IMPORT_EXPANDED_MAX_BYTES) {
          throw tooLarge(`The archive expands past ${MEMO_IMPORT_EXPANDED_MAX_BYTES} bytes`)
        }
        compressedTotal += file.size
        if (
          file.originalSize > RATIO_FLOOR_BYTES
          && file.originalSize > file.size * MEMO_IMPORT_EXPANSION_RATIO
        ) {
          throw tooLarge(`Archive entry ${file.name} expands beyond the allowed ratio`)
        }
        return !directory
      },
    })
    if (
      expandedTotal > RATIO_FLOOR_BYTES
      && expandedTotal > compressedTotal * MEMO_IMPORT_EXPANSION_RATIO
    ) {
      throw tooLarge('The archive expands beyond the allowed ratio')
    }
    return result
  } catch (error) {
    if (error instanceof MemoImportError) throw error
    throw invalid('The archive could not be read as a ZIP file')
  }
}

function checkEntrySize(name: string, size: number): void {
  if (name === MEMO_EXPORT_MANIFEST_ENTRY) {
    if (size > MEMO_IMPORT_MANIFEST_MAX_BYTES) {
      throw tooLarge(`manifest.json exceeds ${MEMO_IMPORT_MANIFEST_MAX_BYTES} bytes`)
    }
    return
  }
  if (RECORD_NAME_PATTERN.test(name)) {
    if (size > MEMO_IMPORT_RECORD_MAX_BYTES) {
      throw tooLarge(`${name} exceeds ${MEMO_IMPORT_RECORD_MAX_BYTES} bytes`)
    }
    return
  }
  if (size > MEMO_IMPORT_CONTENT_MAX_BYTES) {
    throw tooLarge(`${name} exceeds ${MEMO_IMPORT_CONTENT_MAX_BYTES} bytes`)
  }
}

function parseManifest(entries: Unzipped): MemoExportManifest {
  const bytes = entries[MEMO_EXPORT_MANIFEST_ENTRY]
  if (!bytes) throw invalid('manifest.json is missing')
  if (bytes.byteLength > MEMO_IMPORT_MANIFEST_MAX_BYTES) {
    throw tooLarge(`manifest.json exceeds ${MEMO_IMPORT_MANIFEST_MAX_BYTES} bytes`)
  }
  try {
    return parseMemoExportManifest(jsonEntry(entries, MEMO_EXPORT_MANIFEST_ENTRY, MEMO_IMPORT_MANIFEST_MAX_BYTES))
  } catch (error) {
    if (error instanceof MemoExportFormatError) throw invalid(error.message)
    throw error
  }
}

function jsonEntry(entries: Unzipped, name: string, maxBytes: number): unknown {
  const bytes = entries[name]
  if (!bytes) throw invalid(`${name} is missing`)
  if (bytes.byteLength > maxBytes) throw tooLarge(`${name} exceeds ${maxBytes} bytes`)
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    throw invalid(`${name} is not valid UTF-8`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw invalid(`${name} is not valid JSON`)
  }
}

function parseMemoRecord(
  value: unknown,
  path: string,
  entries: Unzipped,
  warnings: IssueLog,
): ImportedMemo {
  const root = objectAt(value, path)
  const uid = uidAt(root, 'uid', `${path}.uid`)
  stringAt(root, 'creator', `${path}.creator`)
  const createTime = timestampAt(root, 'createTime', `${path}.createTime`)
  const updateTime = timestampAt(root, 'updateTime', `${path}.updateTime`)
  const state = stateAt(root, path, warnings)
  const visibility = visibilityAt(root, path, warnings)
  const pinned = booleanAt(root, 'pinned', `${path}.pinned`)
  const contentPath = entryPathAt(root, 'contentPath', `${path}.contentPath`)
  const contentBytes = entries[contentPath]
  if (!contentBytes) throw invalid(`Memo ${uid} content file ${contentPath} is missing`)
  if (contentBytes.byteLength > MEMO_IMPORT_CONTENT_MAX_BYTES) {
    throw tooLarge(`Memo ${uid} content exceeds ${MEMO_IMPORT_CONTENT_MAX_BYTES} bytes`)
  }
  let content: string
  try {
    content = UTF8.decode(contentBytes)
  } catch {
    throw invalid(`Memo ${uid} content is not valid UTF-8`)
  }

  return {
    uid,
    createTime,
    updateTime,
    state,
    visibility,
    pinned,
    contentPath,
    content,
    location: locationAt(root, path, warnings),
    space: spaceAt(root, path),
    parent: root.parent === undefined ? null : uidValue(root.parent, `${path}.parent`),
    relations: relationsAt(root, path, warnings),
    attachments: attachmentsAt(root, path, entries),
  }
}

function stateAt(root: Record<string, unknown>, path: string, warnings: IssueLog): MemoState {
  const value = stringAt(root, 'state', `${path}.state`)
  if (value === 'NORMAL') return 'normal'
  if (value === 'ARCHIVED') return 'archived'
  warnings.add({
    code: 'unknown_state',
    path,
    message: `Unknown state ${value}; the memo was imported as NORMAL`,
  })
  return 'normal'
}

function visibilityAt(
  root: Record<string, unknown>,
  path: string,
  warnings: IssueLog,
): MemoVisibility {
  const value = stringAt(root, 'visibility', `${path}.visibility`)
  if (value === 'PRIVATE') return 'private'
  if (value === 'PROTECTED') return 'protected'
  if (value === 'PUBLIC') return 'public'
  if (value === 'SPACE') {
    if (root.space === undefined) {
      warnings.add({
        code: 'space_missing',
        path,
        message: 'The memo has SPACE visibility without a Space; it was imported as PRIVATE',
      })
    }
    return 'private'
  }
  warnings.add({
    code: 'unknown_visibility',
    path,
    message: `Unknown visibility ${value}; the memo was imported as PRIVATE`,
  })
  return 'private'
}

function locationAt(
  root: Record<string, unknown>,
  path: string,
  warnings: IssueLog,
): MemoLocation | null {
  if (root.location === undefined) return null
  const location = objectAt(root.location, `${path}.location`)
  const placeholder = optionalStringAt(location, 'placeholder', `${path}.location.placeholder`)
  const latitude = optionalNumberAt(location, 'latitude', `${path}.location.latitude`)
  const longitude = optionalNumberAt(location, 'longitude', `${path}.location.longitude`)
  if (latitude === undefined || longitude === undefined) {
    warnings.add({
      code: 'location_incomplete',
      path,
      message: 'The location is missing coordinates and was not imported',
    })
    return null
  }
  if (latitude < -90 || latitude > 90) {
    throw invalid(`${path}.location.latitude must be between -90 and 90`)
  }
  if (longitude < -180 || longitude > 180) {
    throw invalid(`${path}.location.longitude must be between -180 and 180`)
  }
  return { placeholder: placeholder ?? '', latitude, longitude }
}

function spaceAt(root: Record<string, unknown>, path: string): { uid: string; title: string | null } | null {
  if (root.space === undefined) return null
  const space = objectAt(root.space, `${path}.space`)
  return {
    uid: uidAt(space, 'uid', `${path}.space.uid`),
    title: optionalStringAt(space, 'title', `${path}.space.title`) ?? null,
  }
}

function relationsAt(
  root: Record<string, unknown>,
  path: string,
  warnings: IssueLog,
): string[] {
  const values = optionalArrayAt(root, 'relations', `${path}.relations`)
  if (!values) return []
  const relations: string[] = []
  for (let index = 0; index < values.length; index++) {
    const relationPath = `${path}.relations[${index}]`
    const relation = objectAt(values[index], relationPath)
    const type = stringAt(relation, 'type', `${relationPath}.type`)
    const memo = uidAt(relation, 'memo', `${relationPath}.memo`)
    if (type !== 'REFERENCE') {
      warnings.add({
        code: 'unknown_relation_type',
        path: relationPath,
        message: `Unknown relation type ${type}; the relation was skipped`,
      })
      continue
    }
    relations.push(memo)
  }
  return relations
}

function attachmentsAt(
  root: Record<string, unknown>,
  path: string,
  entries: Unzipped,
): ImportedAttachment[] {
  const values = optionalArrayAt(root, 'attachments', `${path}.attachments`)
  if (!values) return []
  return values.map((value, index) => attachmentAt(value, `${path}.attachments[${index}]`, entries))
}

function attachmentAt(value: unknown, path: string, entries: Unzipped): ImportedAttachment {
  const attachment = objectAt(value, path)
  const uid = uidAt(attachment, 'uid', `${path}.uid`)
  const filename = nonEmptyStringAt(attachment, 'filename', `${path}.filename`)
  const mime = stringAt(attachment, 'type', `${path}.type`)
  if (!isMemoExportMediaType(mime)) {
    throw invalid(`${path}.type must be an IANA media type`)
  }
  if (filename.length > 1024) throw invalid(`${path}.filename is too long`)
  const size = nonNegativeIntegerAt(attachment, 'size', `${path}.size`)
  const createTime = timestampAt(attachment, 'createTime', `${path}.createTime`)
  const entryPath = optionalStringAt(attachment, 'path', `${path}.path`)
  const externalLink = optionalStringAt(attachment, 'externalLink', `${path}.externalLink`)
  const sha256 = optionalStringAt(attachment, 'sha256', `${path}.sha256`)

  if (entryPath !== undefined) {
    if (!isMemoExportEntryPath(entryPath)) {
      throw invalid(`${path}.path must be a safe archive entry path`)
    }
    if (externalLink !== undefined) {
      throw invalid(`${path} must carry either path or externalLink, not both`)
    }
    if (sha256 === undefined || !isMemoExportSha256(sha256)) {
      throw invalid(`${path}.sha256 must be a lowercase SHA-256 digest`)
    }
    const bytes = entries[entryPath]
    if (!bytes) throw invalid(`Attachment ${uid} entry ${entryPath} is missing`)
    return {
      uid,
      filename,
      mime,
      size,
      createTime,
      sha256,
      bytes,
      external: false,
    }
  }

  if (externalLink === undefined || !isAbsoluteUri(externalLink)) {
    throw invalid(`${path}.externalLink must be an absolute URI`)
  }
  if (sha256 !== undefined) throw invalid(`${path}.sha256 is not allowed for an external attachment`)
  return {
    uid,
    filename,
    mime,
    size,
    createTime,
    sha256: null,
    bytes: null,
    external: true,
  }
}

function resolveMemoParent(
  memo: ImportedMemo,
  archiveByUid: Map<string, ImportedMemo>,
  targets: Map<string, ImportedTarget>,
  externalRows: Map<string, MemoRowInfo>,
  userId: string,
  warnings: IssueLog,
): string | null {
  if (!memo.parent) return null
  const archived = archiveByUid.get(memo.parent)
  if (archived?.parent) {
    warnings.add({
      code: 'parent_not_top_level',
      path: recordPath(memo),
      message: `Parent ${memo.parent} is itself a comment; the memo was imported as a top-level memo`,
    })
    return null
  }
  const target = targets.get(memo.parent)
  if (target) {
    if (target.parentId) {
      warnings.add({
        code: 'parent_not_top_level',
        path: recordPath(memo),
        message: `Parent ${memo.parent} is itself a comment; the memo was imported as a top-level memo`,
      })
      return null
    }
    if (target.state !== 'normal') {
      warnings.add({
        code: 'parent_archived',
        path: recordPath(memo),
        message: `Parent ${memo.parent} is archived; the memo was imported as a top-level memo`,
      })
      return null
    }
    return target.id
  }
  const external = externalRows.get(memo.parent)
  if (external && external.user_id === userId) {
    if (external.parent_id) {
      warnings.add({
        code: 'parent_not_top_level',
        path: recordPath(memo),
        message: `Parent ${memo.parent} is itself a comment; the memo was imported as a top-level memo`,
      })
      return null
    }
    if (external.state !== 'normal') {
      warnings.add({
        code: 'parent_archived',
        path: recordPath(memo),
        message: `Parent ${memo.parent} is archived; the memo was imported as a top-level memo`,
      })
      return null
    }
    return external.id
  }
  warnings.add({
    code: 'parent_missing',
    path: recordPath(memo),
    message: `Parent ${memo.parent} was not imported; the memo was imported as a top-level memo`,
  })
  return null
}

async function prepareAttachments(
  env: Env,
  userId: string,
  memo: ImportedMemo,
  memoId: string,
  existing: Map<string, AttachmentRowInfo>,
  warnings: IssueLog,
): Promise<PreparedAttachments> {
  const ids: string[] = []
  const createdIds: string[] = []

  for (const attachment of memo.attachments) {
    if (attachment.external) {
      warnings.add({
        code: 'external_attachment',
        path: recordPath(memo),
        message: `External attachment ${attachment.uid} cannot be imported`,
      })
      continue
    }
    if (!attachment.bytes || !attachment.sha256) {
      return {
        ids,
        createdIds,
        failure: { code: 'attachment_invalid', path: recordPath(memo), message: `Attachment ${attachment.uid} has no bytes` },
      }
    }
    if (attachment.bytes.byteLength > MEMO_ATTACHMENT_MAX_BYTES) {
      return {
        ids,
        createdIds,
        failure: {
          code: 'attachment_too_large',
          path: recordPath(memo),
          message: `Attachment ${attachment.uid} exceeds the ${MEMO_ATTACHMENT_MAX_BYTES} byte limit`,
        },
      }
    }
    if (attachment.bytes.byteLength !== attachment.size) {
      return {
        ids,
        createdIds,
        failure: {
          code: 'attachment_size_mismatch',
          path: recordPath(memo),
          message: `Attachment ${attachment.uid} does not match its recorded size`,
        },
      }
    }
    if (await sha256Hex(attachment.bytes) !== attachment.sha256) {
      return {
        ids,
        createdIds,
        failure: {
          code: 'attachment_digest_mismatch',
          path: recordPath(memo),
          message: `Attachment ${attachment.uid} does not match its recorded SHA-256 digest`,
        },
      }
    }
  }

  for (const attachment of memo.attachments) {
    if (attachment.external || !attachment.bytes || !attachment.sha256) continue
    const reusable = await reusableAttachmentId(env, userId, attachment, memoId, existing)
    if (reusable) {
      ids.push(reusable)
      continue
    }
    const id = freshAttachmentId(attachment, existing)
    try {
      const saved = await saveMemoAttachment(env, {
        id,
        userId,
        memoId: null,
        filename: attachment.filename,
        reportedMime: attachment.mime,
        bytes: attachment.bytes,
        thumbnail: null,
        mediaMetadata: null,
        motionGroupId: null,
        motionRole: null,
        createdAt: attachment.createTime,
      })
      ids.push(saved.id)
      createdIds.push(saved.id)
    } catch (error) {
      await discardCreatedAttachments(env, userId, createdIds)
      if (error instanceof MemoAttachmentError) {
        if (error.status === 503) {
          throw new MemoImportError(503, 'storage_unavailable', error.message)
        }
        return {
          ids: [],
          createdIds: [],
          failure: {
            code: error.code,
            path: recordPath(memo),
            message: `Attachment ${attachment.uid} could not be imported: ${error.message}`,
          },
        }
      }
      throw error
    }
  }

  return { ids, createdIds, failure: null }
}

async function reusableAttachmentId(
  env: Env,
  userId: string,
  attachment: ImportedAttachment,
  memoId: string,
  existing: Map<string, AttachmentRowInfo>,
): Promise<string | null> {
  const row = existing.get(attachment.uid)
  if (!row || row.user_id !== userId) return null
  if (row.memo_id !== null && row.memo_id !== memoId) return null
  if (!attachment.bytes || !attachment.sha256 || Number(row.size) !== attachment.bytes.byteLength) return null
  if (!hasAttachmentStorage(env, row.storage)) return null
  try {
    const stored = await readAttachmentObject(env, row.storage, row.storage_key)
    if (!stored || stored.byteLength !== attachment.bytes.byteLength) return null
    return await sha256Hex(stored) === attachment.sha256 ? row.id : null
  } catch (error) {
    console.warn('[inkstone] An existing attachment could not be verified during import:', error)
    return null
  }
}

function freshAttachmentId(attachment: ImportedAttachment, existing: Map<string, AttachmentRowInfo>): string {
  if (!existing.has(attachment.uid) && isValidId(attachment.uid)) return attachment.uid
  const id = newId()
  return existing.has(id) ? newId() : id
}

async function discardCreatedAttachments(env: Env, userId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  try {
    await deleteMemoAttachments(env, userId, ids)
  } catch (error) {
    console.warn('[inkstone] Attachments from a failed import record could not be removed:', error)
  }
}

async function createMemoWithRetry(
  db: D1Database,
  userId: string,
  memo: ImportedMemo,
  id: string,
  parentId: string | null,
  spaceId: string | null,
  attachmentIds: readonly string[],
): Promise<{ id: string; rev: number }> {
  let targetId = id
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    try {
      const created = await createMemo(db, userId, {
        id: targetId,
        content: memo.content,
        visibility: memo.visibility,
        spaceId,
        parentId,
        location: memo.location,
        attachmentIds,
        createdAt: memo.createTime,
        updatedAt: memo.updateTime,
      })
      return { id: created.id, rev: created.rev }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt < ID_ATTEMPTS - 1) {
        targetId = newId()
        continue
      }
      throw error
    }
  }
  throw ApiError.conflict('Could not allocate a memo id. Try again')
}

async function newMemoId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const id = newId()
    const row = await db.prepare('SELECT id FROM memos_items WHERE id = ?1').bind(id).first<{ id: string }>()
    if (!row) return id
  }
  throw ApiError.conflict('Could not allocate a memo id. Try again')
}

async function writeRelations(
  db: D1Database,
  memoId: string,
  relatedIds: readonly string[],
  replace: boolean,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  if (replace) {
    statements.push(db.prepare('DELETE FROM memos_relations WHERE memo_id = ?1').bind(memoId))
  }
  const createdAt = nowSeconds()
  for (const relatedId of relatedIds) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO memos_relations (memo_id, related_memo_id, created_at) VALUES (?1, ?2, ?3)')
        .bind(memoId, relatedId, createdAt),
    )
  }
  for (const chunk of chunks(statements, STATEMENT_CHUNK)) await db.batch(chunk)
}

function orderedMemos(memos: readonly ImportedMemo[]): ImportedMemo[] {
  const byTime = (left: ImportedMemo, right: ImportedMemo): number =>
    left.createTime - right.createTime || left.uid.localeCompare(right.uid)
  return [
    ...memos.filter((memo) => !memo.parent).sort(byTime),
    ...memos.filter((memo) => memo.parent).sort(byTime),
  ]
}

async function loadMemoRows(db: D1Database, ids: readonly string[]): Promise<Map<string, MemoRowInfo>> {
  const rows = new Map<string, MemoRowInfo>()
  const unique = [...new Set(ids.filter((id) => isValidId(id)))]
  for (const chunk of chunks(unique, LOOKUP_CHUNK)) {
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const { results } = await db
      .prepare(
        `SELECT id, user_id, parent_id, state, rev
           FROM memos_items
          WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<MemoRowInfo>()
    for (const row of results) rows.set(row.id, row)
  }
  return rows
}

async function loadAttachmentRows(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, AttachmentRowInfo>> {
  const rows = new Map<string, AttachmentRowInfo>()
  const unique = [...new Set(ids)]
  for (const chunk of chunks(unique, LOOKUP_CHUNK)) {
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const { results } = await db
      .prepare(
        `SELECT id, user_id, memo_id, filename, mime, size, storage, storage_key
           FROM memos_attachments
          WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<AttachmentRowInfo>()
    for (const row of results) rows.set(row.id, row)
  }
  return rows
}

async function currentAttachmentIds(
  db: D1Database,
  userId: string,
  memoId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM memos_attachments WHERE user_id = ?1 AND memo_id = ?2')
    .bind(userId, memoId)
    .all<{ id: string }>()
  return results.map((row) => row.id)
}

class ImportSpaceResolver {
  private readonly cache = new Map<string, string>()

  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async resolve(space: { uid: string; title: string | null }): Promise<string> {
    const cached = this.cache.get(space.uid)
    if (cached) return cached

    const own = await this.db.prepare(
      'SELECT id FROM memos_spaces WHERE id = ?1 AND user_id = ?2',
    )
      .bind(space.uid, this.userId)
      .first<{ id: string }>()
    if (own) {
      this.cache.set(space.uid, own.id)
      return own.id
    }

    const title = (space.title?.trim() || space.uid).slice(0, 120)
    const byTitle = await this.db.prepare(
      `SELECT id FROM memos_spaces
        WHERE user_id = ?1 AND lower(title) = lower(?2)
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
      .bind(this.userId, title)
      .first<{ id: string }>()
    if (byTitle) {
      this.cache.set(space.uid, byTitle.id)
      return byTitle.id
    }

    const taken = await this.db.prepare('SELECT id FROM memos_spaces WHERE id = ?1')
      .bind(space.uid)
      .first<{ id: string }>()
    let id = !taken && isValidId(space.uid) ? space.uid : newId()
    const now = nowSeconds()
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      if (attempt > 0) id = newId()
      const { meta } = await this.db.prepare(
        `INSERT OR IGNORE INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', '', ?4, ?4)`,
      )
        .bind(id, this.userId, title, now)
        .run()
      if (meta.changes) {
        this.cache.set(space.uid, id)
        return id
      }
      const raced = await this.db.prepare(
        'SELECT id FROM memos_spaces WHERE id = ?1 AND user_id = ?2',
      )
        .bind(id, this.userId)
        .first<{ id: string }>()
      if (raced) {
        this.cache.set(space.uid, raced.id)
        return raced.id
      }
    }
    throw ApiError.conflict('Could not allocate a space id. Try again')
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalArrayAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] | null {
  const value = record[key]
  if (value === undefined) return null
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`)
  return value
}

function stringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw invalid(`${path} must be a string`)
  return value
}

function nonEmptyStringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = stringAt(record, key, path)
  if (!value) throw invalid(`${path} must not be empty`)
  return value
}

function optionalStringAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  return record[key] === undefined ? undefined : stringAt(record, key, path)
}

function booleanAt(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw invalid(`${path} must be a boolean`)
  return value
}

function optionalNumberAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${path} must be a finite number`)
  }
  return value
}

function nonNegativeIntegerAt(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${path} must be a non-negative integer`)
  }
  return value
}

function uidValue(value: unknown, path: string): string {
  if (!isMemoExportUid(value)) throw invalid(`${path} must be a valid UID`)
  return value
}

function uidAt(record: Record<string, unknown>, key: string, path: string): string {
  return uidValue(record[key], path)
}

function entryPathAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = stringAt(record, key, path)
  if (!isMemoExportEntryPath(value)) throw invalid(`${path} must be a safe archive entry path`)
  return value
}

function timestampAt(record: Record<string, unknown>, key: string, path: string): number {
  const value = stringAt(record, key, path)
  if (!isMemoExportTimestamp(value)) throw invalid(`${path} must be an RFC 3339 UTC timestamp`)
  return Math.floor(Date.parse(value) / 1000)
}

function isAbsoluteUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol)
  } catch {
    return false
  }
}

function recordPath(memo: ImportedMemo): string {
  return `memos/${memo.uid}.json`
}

function unixSeconds(timestamp: string): number | null {
  const millis = Date.parse(timestamp)
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000)
}

function invalid(message: string): MemoImportError {
  return new MemoImportError(400, 'memo_import_invalid', message)
}

function tooLarge(message: string): MemoImportError {
  return new MemoImportError(413, 'memo_import_too_large', message)
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size))
  }
  return output
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
