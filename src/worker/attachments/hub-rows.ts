import {
  type HubAttachmentListParams,
  type HubAttachmentOwner,
  type HubAttachmentSizeRange,
  type HubAttachmentSort,
  type HubAttachmentStats,
  type HubAttachmentType,
  type HubAttachmentWithUsage,
  type AttachmentHubScope,
} from '@shared/attachment-hub'
import { isValidId } from '../lib/id'
import { collectAttachmentReferences } from './references'
import { attachmentScope, scopeColumnFilter, type AttachmentScopeDescriptor } from './scopes'

/**
 * Reading and organising hub rows across the three tables the four applications keep them in.
 *
 * Every statement is narrowed twice: by the account taken from the session, and by the scope
 * resolved against the registry before it reached this file. Neither is ever interpolated from a
 * caller — table and column names come from the descriptor's literal union, and anything a client
 * sent arrives as a bound parameter.
 */

const LIST_PAGE_SIZE = 500
const LIST_PAGE_MAX = 500
const OWNER_SCAN_LIMIT = 20
const SMALL_BYTES = 100 * 1024
const MEDIUM_BYTES = 5 * 1024 * 1024
const EXTENSION_BREAKDOWN_MAX = 24

interface HubRow {
  id: string
  filename: string
  mime: string
  size: number
  folder_id: string | null
  is_starred: number
  is_pinned: number
  tags: string
  created_at: number
  owner_id: string | null
  object_key: string | null
  width: number | null
  height: number | null
}

const TYPE_CONDITIONS: Record<HubAttachmentType, string> = {
  image: `mime LIKE 'image/%'`,
  pdf: `mime = 'application/pdf'`,
  document: `(mime LIKE 'text/%' OR mime LIKE 'application/pdf' OR mime LIKE 'application/msword%' OR mime LIKE 'application/vnd.%')`,
  media: `(mime LIKE 'audio/%' OR mime LIKE 'video/%')`,
  archive: `(mime LIKE '%zip%' OR mime LIKE '%tar%' OR mime LIKE '%gzip%' OR mime LIKE '%7z%' OR mime LIKE '%rar%')`,
  code: `(mime LIKE 'application/json%' OR mime LIKE 'application/javascript%' OR mime LIKE 'application/xml%' OR mime LIKE 'application/x-sh%' OR ${extensionArm(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'css', 'scss', 'html', 'md', 'sql', 'sh', 'yaml', 'yml', 'toml', 'rb', 'php'])})`,
}

const SIZE_RANGE_CONDITIONS: Record<HubAttachmentSizeRange, string> = {
  small: `(size < ${SMALL_BYTES})`,
  medium: `(size >= ${SMALL_BYTES} AND size < ${MEDIUM_BYTES})`,
  large: `(size >= ${MEDIUM_BYTES})`,
}

const SORTS: Record<HubAttachmentSort, string> = {
  date_desc: 'created_at DESC, id DESC',
  date_asc: 'created_at ASC, id ASC',
  name_asc: 'filename COLLATE NOCASE ASC, id ASC',
  name_desc: 'filename COLLATE NOCASE DESC, id DESC',
  size_desc: 'size DESC, id DESC',
  size_asc: 'size ASC, id ASC',
}

function extensionArm(extensions: readonly string[]): string {
  return extensions.map((ext) => `lower(filename) LIKE '%.${ext}'`).join(' OR ')
}

/**
 * Accumulates the bound values so a fragment can ask for the placeholder that comes next.
 *
 * Interpolating `?N` by hand across a growing filter list is where this kind of query goes wrong:
 * one branch that pushes without emitting, or emits without pushing, and every later clause reads a
 * value meant for another. The account id is always first, so the counter starts at one.
 */
class Bindings {
  private readonly values: (string | number)[] = []

  constructor(userId: string) {
    this.values.push(userId)
  }

  param(value: string | number): string {
    this.values.push(value)
    return `?${this.values.length}`
  }

  get count(): number {
    return this.values.length
  }

  /** The account id, for the fragments that need it a second time in the same statement. */
  userId(): string {
    return this.values[0] as string
  }

  bind(...trailing: (string | number)[]): (string | number)[] {
    return [...this.values, ...trailing]
  }
}

function rowColumns(descriptor: AttachmentScopeDescriptor): string {
  const owner = descriptor.ownerColumn ?? 'NULL'
  const dimensions = descriptor.hasDimensions ? 'width, height' : 'NULL AS width, NULL AS height'
  return `id, filename, mime, size, folder_id, is_starred, is_pinned, tags, created_at,
          ${owner} AS owner_id, ${descriptor.keyColumn} AS object_key, ${dimensions}`
}

function toHubAttachment(
  scope: AttachmentHubScope,
  row: HubRow,
  references: number,
): HubAttachmentWithUsage {
  const descriptor = attachmentScope(scope)
  const url = `${descriptor.urlBase}/${row.id}`
  return {
    id: row.id,
    scope,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url,
    thumbnailUrl: descriptor.table === 'memos_attachments' ? `${url}?thumb=1` : null,
    folderId: row.folder_id,
    isStarred: Boolean(row.is_starred),
    isPinned: Boolean(row.is_pinned),
    tags: decodeTags(row.tags),
    ownerId: row.owner_id,
    createdAt: normalizeCreatedAt(row.created_at),
    references,
  }
}

/**
 * Memos stamps its rows in seconds and every other scope in milliseconds.
 *
 * Left alone, a listing that spans the two would order every ten-digit memo time before every
 * thirteen-digit note time regardless of when either happened. The hub widens the older clock on the
 * way out rather than asking an application to rewrite its history — the cursor still carries the
 * raw column value, because that is what the keyset comparison reads.
 */
function normalizeCreatedAt(value: number): number {
  return value < 1e11 ? value * 1000 : value
}

function decodeTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** The `WHERE` terms for one request, in the order their values are bound. */
function buildWhere(
  scope: AttachmentHubScope,
  params: HubAttachmentListParams,
  bindings: Bindings,
): string[] {
  const clauses = [`user_id = ?1`, scopeColumnFilter(scope)]

  if (params.folderId === 'unfiled') clauses.push('folder_id IS NULL')
  else if (params.folderId) clauses.push(`folder_id = ${bindings.param(params.folderId)}`)

  if (params.type) clauses.push(`(${TYPE_CONDITIONS[params.type]})`)
  if (params.sizeRange) clauses.push(SIZE_RANGE_CONDITIONS[params.sizeRange])
  if (typeof params.minBytes === 'number') clauses.push(`size >= ${bindings.param(params.minBytes)}`)
  if (typeof params.maxBytes === 'number') clauses.push(`size <= ${bindings.param(params.maxBytes)}`)
  if (params.tag) clauses.push(`instr(tags, ${bindings.param(`"${params.tag}"`)}) > 0`)
  if (params.starred) clauses.push('is_starred = 1')
  if (params.pinned) clauses.push('is_pinned = 1')

  if (params.extension) {
    const wanted = params.extension
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => /^[a-z0-9]{1,12}$/.test(part))
      .slice(0, 40)
    if (wanted.length) {
      clauses.push(`(${wanted.map((ext) => `lower(filename) LIKE ${bindings.param(`%.${ext}`)}`).join(' OR ')})`)
    }
  }

  if (params.search) {
    clauses.push(`lower(filename) LIKE ${bindings.param(`%${escapeLike(params.search.toLowerCase())}%`)} ESCAPE '\\'`)
  }

  if (params.cursor) {
    const cursor = parseCursor(params.cursor)
    if (cursor) {
      const at = bindings.param(cursor.createdAt)
      const idAt = bindings.param(cursor.id)
      const ascending = params.sort === 'date_asc' || params.sort === 'name_asc' || params.sort === 'size_asc'
      const before = ascending ? '>' : '<'
      clauses.push(`(created_at ${before} ${at} OR (created_at = ${at} AND id ${before} ${idAt}))`)
    }
  }

  return clauses
}

export interface HubListResult {
  files: HubAttachmentWithUsage[]
  nextCursor: string | null
  stats: HubAttachmentStats
}

export async function listHubAttachments(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  params: HubAttachmentListParams,
  quotaBytes: number,
): Promise<HubListResult> {
  const descriptor = attachmentScope(scope)
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? LIST_PAGE_SIZE) || 1, 1), LIST_PAGE_MAX)
  const sort = SORTS[params.sort ?? 'date_desc'] ?? SORTS.date_desc
  const bindings = new Bindings(userId)
  const clauses = buildWhere(scope, params, bindings)
  const pageParam = bindings.param(limit + 1)

  const { results } = await db
    .prepare(
      `SELECT ${rowColumns(descriptor)} FROM ${descriptor.table}
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${sort} LIMIT ${pageParam}`,
    )
    .bind(...bindings.bind())
    .all<HubRow>()

  const page = results.slice(0, limit)
  const hasMore = results.length > limit
  const references = await collectAttachmentReferences(
    db,
    userId,
    new Set(page.map((row) => row.id)),
    scope,
  )
  const last = page[page.length - 1]
  const stats = await loadHubStats(db, userId, scope, descriptor, quotaBytes)

  return {
    files: page
      .filter((row) => !params.unreferenced || !references.has(row.id))
      .map((row) => toHubAttachment(scope, row, references.get(row.id) ?? 0)),
    nextCursor: hasMore && last ? `${last.created_at}.${last.id}` : null,
    stats,
  }
}

function parseCursor(raw: string): { createdAt: number; id: string } | null {
  const match = /^(\d{1,16})\.([0-9a-hjkmnp-tv-z]{26})$/.exec(raw)
  if (!match) return null
  return { createdAt: Number(match[1]), id: match[2]! }
}

const BUCKET_ARMS: Record<'image' | 'document' | 'media' | 'archive' | 'code', string> = {
  image: TYPE_CONDITIONS.image,
  document: TYPE_CONDITIONS.document,
  media: TYPE_CONDITIONS.media,
  archive: TYPE_CONDITIONS.archive,
  code: TYPE_CONDITIONS.code,
}

async function loadHubStats(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  descriptor: AttachmentScopeDescriptor,
  quotaBytes: number,
): Promise<HubAttachmentStats> {
  const from = `FROM ${descriptor.table} WHERE user_id = ?1 AND ${scopeColumnFilter(scope)}`
  const totals = await db
    .prepare(
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(SUM(size), 0) AS total_bytes,
         COALESCE(SUM(CASE WHEN ${BUCKET_ARMS.image} THEN size ELSE 0 END), 0) AS image_bytes,
         COALESCE(SUM(CASE WHEN ${BUCKET_ARMS.document} AND NOT ${BUCKET_ARMS.image} THEN size ELSE 0 END), 0) AS document_bytes,
         COALESCE(SUM(CASE WHEN ${BUCKET_ARMS.media} THEN size ELSE 0 END), 0) AS media_bytes,
         COALESCE(SUM(CASE WHEN ${BUCKET_ARMS.archive} THEN size ELSE 0 END), 0) AS archive_bytes,
         COALESCE(SUM(CASE WHEN ${BUCKET_ARMS.code} AND NOT ${BUCKET_ARMS.image} THEN size ELSE 0 END), 0) AS code_bytes
       ${from}`,
    )
    .bind(userId)
    .first<Record<string, number>>()

  const breakdown = await db
    .prepare(
      `SELECT lower(substr(filename, instr(filename, '.') + 1)) AS extension,
              COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       ${from} AND instr(filename, '.') > 0
       GROUP BY extension HAVING length(extension) BETWEEN 1 AND 12
       ORDER BY bytes DESC LIMIT ${EXTENSION_BREAKDOWN_MAX}`,
    )
    .bind(userId)
    .all<{ extension: string; count: number; bytes: number }>()

  const referenced = await collectAttachmentReferences(db, userId, undefined, scope)
  const largest = await db
    .prepare(
      `SELECT ${rowColumns(descriptor)} ${from} ORDER BY size DESC, id DESC LIMIT 5`,
    )
    .bind(userId)
    .all<HubRow>()

  const organizers = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM attachment_folders WHERE user_id = ?1 AND scope = ?2`).bind(userId, scope),
    db.prepare(`SELECT COUNT(*) AS n FROM attachment_tags WHERE user_id = ?1 AND scope = ?2`).bind(userId, scope),
  ])

  const totalBytes = Number(totals?.total_bytes ?? 0)
  const imageBytes = Number(totals?.image_bytes ?? 0)
  const documentBytes = Number(totals?.document_bytes ?? 0)
  const mediaBytes = Number(totals?.media_bytes ?? 0)
  const archiveBytes = Number(totals?.archive_bytes ?? 0)
  const codeBytes = Number(totals?.code_bytes ?? 0)
  const totalCount = Number(totals?.total_count ?? 0)
  const extensionBreakdown: HubAttachmentStats['extensionBreakdown'] = {}
  for (const row of breakdown.results) {
    extensionBreakdown[row.extension] = { count: row.count, bytes: row.bytes }
  }

  return {
    totalCount,
    totalBytes,
    totalQuotaBytes: quotaBytes,
    imageBytes,
    documentBytes,
    mediaBytes,
    archiveBytes,
    codeBytes,
    otherBytes: Math.max(
      0,
      totalBytes - imageBytes - documentBytes - mediaBytes - archiveBytes - codeBytes,
    ),
    unreferencedCount: Math.max(0, totalCount - referenced.size),
    folderCount: Number((organizers[0]?.results?.[0] as { n: number } | undefined)?.n ?? 0),
    tagCount: Number((organizers[1]?.results?.[0] as { n: number } | undefined)?.n ?? 0),
    extensionBreakdown,
    largestFiles: largest.results.map((row) => toHubAttachment(scope, row, referenced.get(row.id) ?? 0)),
  }
}

/**
 * Whether a row may still be deleted, asked of the row's own tables inside the delete statement.
 *
 * A snapshot taken before the sweep is not enough for two of these scopes. Notes can watch the
 * change log, but task and memo links never enter it — `ChangeEntity` has no member for either — so
 * a guard built on sequence numbers would let a link created while the sweep was running be
 * overwritten by a delete that had already decided the file was spare. Re-asking at the moment of
 * deletion closes that window without needing a log the scope does not write.
 */
function livenessGuard(scope: AttachmentHubScope, userIdParam: string, idParam: string): string {
  switch (scope) {
    case 'notes':
      return `(note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n WHERE n.id = attachments.note_id AND n.deleted_at IS NULL
      ))`
    case 'todos':
      return `NOT EXISTS (
        SELECT 1 FROM todos_attachments ta
         WHERE ta.user_id = ${userIdParam} AND ta.attachment_id = ${idParam}
      )`
    case 'memos':
      return 'memo_id IS NULL'
    case 'chat':
      return `NOT EXISTS (
        SELECT 1 FROM chat_messages cm
         WHERE cm.user_id = ${userIdParam} AND cm.attachments != '[]'
           AND instr(cm.attachments, ${quotedIdParam(idParam)}) > 0
      )`
  }
}

function quotedIdParam(idParam: string): string {
  return `'"' || ${idParam} || '"'`
}

export interface HubRowForDelete {
  id: string
  size: number
  objectKey: string
  storage: 'r2' | 'kv'
}

/** Chat resolves its backend per call instead of recording it, so a hub read cannot report one. */
function storageSelect(scope: AttachmentHubScope): string {
  return scope === 'chat' ? `'r2' AS storage` : 'storage'
}

export async function loadHubRowForDeletion(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  id: string,
): Promise<HubRowForDelete | null> {
  if (!isValidId(id)) return null
  const descriptor = attachmentScope(scope)
  return db
    .prepare(
      `SELECT id, size, ${descriptor.keyColumn} AS object_key, ${storageSelect(scope)}
         FROM ${descriptor.table}
        WHERE user_id = ?1 AND id = ?2 AND ${scopeColumnFilter(scope)}`,
    )
    .bind(userId, id)
    .first<HubRowForDelete>()
}

export async function deleteHubRow(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  id: string,
): Promise<boolean> {
  const descriptor = attachmentScope(scope)
  const outcome = await db
    .prepare(
      `DELETE FROM ${descriptor.table}
        WHERE user_id = ?1 AND id = ?2 AND ${scopeColumnFilter(scope)}
          AND ${livenessGuard(scope, '?1', '?2')}`,
    )
    .bind(userId, id)
    .run()
  return Boolean(outcome.meta.changes)
}

export async function patchHubRow(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  id: string,
  patch: { filename?: string; folderId?: string | null; isStarred?: boolean; isPinned?: boolean; tags?: string[] },
): Promise<boolean> {
  const descriptor = attachmentScope(scope)
  const sets: string[] = []
  const bindings = new Bindings(userId)
  const idParam = bindings.param(id)

  if (patch.filename !== undefined) sets.push(`filename = ${bindings.param(patch.filename)}`)
  if (patch.folderId !== undefined) {
    sets.push(`folder_id = ${patch.folderId ? bindings.param(patch.folderId) : 'NULL'}`)
  }
  if (patch.isStarred !== undefined) sets.push(`is_starred = ${bindings.param(patch.isStarred ? 1 : 0)}`)
  if (patch.isPinned !== undefined) sets.push(`is_pinned = ${bindings.param(patch.isPinned ? 1 : 0)}`)
  if (patch.tags !== undefined) sets.push(`tags = ${bindings.param(JSON.stringify(patch.tags))}`)
  if (!sets.length) return false

  await db
    .prepare(
      `UPDATE ${descriptor.table} SET ${sets.join(', ')}
        WHERE user_id = ?1 AND id = ${idParam} AND ${scopeColumnFilter(scope)}`,
    )
    .bind(...bindings.bind())
    .run()
  return true
}

export async function listHubOwners(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  id: string,
): Promise<HubAttachmentOwner[]> {
  if (scope === 'chat') {
    const { results } = await db
      .prepare(
        `SELECT cm.conversation_id AS id FROM chat_messages cm
          WHERE cm.user_id = ?1 AND cm.attachments != '[]' AND instr(cm.attachments, ?2) > 0
          ORDER BY cm.created_at DESC LIMIT ?3`,
      )
      .bind(userId, `"${id}"`, OWNER_SCAN_LIMIT)
      .all<{ id: string }>()
    return results.map((row) => ({ id: row.id, title: '' }))
  }

  const link =
    scope === 'todos'
      ? `SELECT t.id AS id, t.title AS title FROM todos_tasks t
           JOIN todos_attachments ta ON ta.user_id = t.user_id AND ta.task_id = t.id
          WHERE ta.user_id = ?1 AND ta.attachment_id = ?2
          ORDER BY ta.created_at DESC LIMIT ?3`
      : scope === 'memos'
        ? `SELECT m.id AS id, m.content AS title FROM memos_items m
             JOIN memos_attachments a ON a.user_id = m.user_id AND a.memo_id = m.id
            WHERE m.user_id = ?1 AND a.id = ?2 ORDER BY m.updated_at DESC LIMIT ?3`
        : `SELECT n.id AS id, n.title AS title FROM attachments a
             JOIN notes n ON n.user_id = a.user_id AND n.id = a.note_id
            WHERE a.user_id = ?1 AND a.id = ?2 AND n.deleted_at IS NULL LIMIT ?3`
  const { results } = await db
    .prepare(link)
    .bind(userId, id, OWNER_SCAN_LIMIT)
    .all<{ id: string; title: string }>()
  return results.map((row) => ({ id: row.id, title: (row.title ?? '').slice(0, 120) }))
}

/** One row as the hub presents it, for a mutation's response. Null when this scope has no such row. */
export async function getHubAttachment(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
  id: string,
): Promise<HubAttachmentWithUsage | null> {
  if (!isValidId(id)) return null
  const descriptor = attachmentScope(scope)
  const row = await db
    .prepare(
      `SELECT ${rowColumns(descriptor)} FROM ${descriptor.table}
        WHERE user_id = ?1 AND id = ?2 AND ${scopeColumnFilter(scope)}`,
    )
    .bind(userId, id)
    .first<HubRow>()
  if (!row) return null
  const references = await collectAttachmentReferences(db, userId, new Set([id]), scope)
  return toHubAttachment(scope, row, references.get(id) ?? 0)
}

export const HUB_LIST_PAGE_SIZE = LIST_PAGE_SIZE
export { livenessGuard }

const PRUNE_PAGE_SIZE = 100

export interface HubPruneOutcome {
  removed: number
  freedBytes: number
  /** Objects whose rows went but whose bytes did not, handed to the retry queue. */
  cleanupPending: boolean
}

/**
 * Deletes the files this scope nothing points at any more.
 *
 * Each candidate is deleted by a statement that re-asks the liveness question rather than by one
 * that trusts the scan which found it. That is deliberate: the scan can be long, and the two scopes
 * whose links are never written to the change log have no way to tell a running sweep that
 * something just claimed a file. A delete that finds the file claimed at the last moment is a
 * delete that does nothing, which is the only safe outcome available.
 */
export async function pruneHubAttachments(
  db: D1Database,
  userId: string,
  scope: AttachmentHubScope,
): Promise<HubPruneOutcome> {
  const descriptor = attachmentScope(scope)
  const referenced = await collectAttachmentReferences(db, userId, undefined, scope)
  let removed = 0
  let freedBytes = 0
  let afterId = ''

  while (true) {
    const { results } = await db
      .prepare(
        `SELECT id, size, ${descriptor.keyColumn} AS object_key, ${storageSelect(scope)}
           FROM ${descriptor.table}
          WHERE user_id = ?1 AND id > ?2 AND ${scopeColumnFilter(scope)}
          ORDER BY id ASC LIMIT ?3`,
      )
      .bind(userId, afterId, PRUNE_PAGE_SIZE)
      .all<{ id: string; size: number; object_key: string; storage: 'r2' | 'kv' }>()
    if (!results.length) break

    const candidates = results.filter((row) => !referenced.has(row.id))
    for (const candidate of candidates) {
      const deleted = await deleteHubRow(db, userId, scope, candidate.id)
      if (!deleted) continue
      removed++
      freedBytes += candidate.size
      await queueHubCleanup(db, userId, candidate.storage, candidate.object_key)
    }

    afterId = results[results.length - 1]!.id
    if (results.length < PRUNE_PAGE_SIZE) break
  }

  return { removed, freedBytes, cleanupPending: false }
}

async function queueHubCleanup(
  db: D1Database,
  userId: string,
  storage: 'r2' | 'kv',
  objectKey: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
    )
    .bind(`${storage}:${objectKey}`, userId, Date.now())
    .run()
}

