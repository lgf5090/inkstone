/**
 * The archive transport: a v3 ZIP out, a v3 ZIP or a v1 JSON in. The JSONL mapping itself lives in
 * the shared module so the browser converters and this server agree byte for byte; this file only
 * zips, unzips, and writes the imported rows. Import preserves the archive's ids (so a round trip is
 * field-equal) but the new board belongs to whoever imports it. Member rows are deliberately not
 * restored: an archive is data, not an invitation, and no local account may join a board because an
 * uploaded file said so.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate'
import { z } from 'zod'
import type { ProjectAttachment, ProjectBoard, ProjectBoardBundle, ProjectBoardSummary, ProjectRole } from '@shared/project/model'
import {
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveBlockSchema,
  ProjectArchiveHeaderSchema,
  parseProjectArchiveLines,
  serializeProjectArchiveLines,
  type ProjectArchiveAttachment,
  type ProjectArchiveLine,
} from '@shared/project/archive'
import { projectArchiveLinesToImport, projectBundleToArchiveLines } from '@shared/project/archive-mapping'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { serializeProjectRecurrence } from '@shared/project/recurrence'
import { serializeProjectPropertyConfig } from '@shared/project/property-config'
import { ApiError } from '../lib/errors'
import { readProjectBoardBundle } from './bundle'
import { duplicateProjectBoard } from './duplicate'
import { listBoardLinks } from './enhance'
import { projectRelationTargets, relationEdgeStatements } from './relations'
import { listBoardAttachments, projectAttachmentObjectKey } from './files'
import { ProjectStore } from './store'
import { assertProjectBatchStatementLimit } from './d1'
import { projectParentMapHasCycle } from '@shared/project/hierarchy'
import {
  ProjectBoardCreateSchema,
  ProjectCardCreateSchema,
  ProjectCommentCreateSchema,
  ProjectContentCreateSchema,
  ProjectContentFieldsSchema,
  ProjectPropertyOptionSchema,
  ProjectPropertySchema,
  ProjectViewCreateSchema,
} from '@shared/project/validation'

const ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
const ARCHIVE_MAX_FILES = 100
const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const ARCHIVE_MAX_CONTENTS = 20000
const ARCHIVE_MAX_COMMENTS = 20000
const ARCHIVE_MAX_LINKS = 40000
const ARCHIVE_MAX_ATTACHMENTS = 500
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const isArchiveId = (value: string): boolean => ARCHIVE_ID_PATTERN.test(value)
const archiveIdSchema = z.string().refine(isArchiveId, 'invalid id')
const archiveBoardSchema = ProjectBoardCreateSchema.omit({ id: true })
const archivePropertySchema = ProjectPropertySchema.extend({
  id: archiveIdSchema,
  options: z.array(ProjectPropertyOptionSchema.extend({ id: archiveIdSchema })).max(PROJECT_LIMITS.optionsPerProperty),
})
const archiveValueMap = z.record(archiveIdSchema, z.string().max(PROJECT_LIMITS.fieldsRunes))
  .refine((values) => Object.keys(values).length <= PROJECT_LIMITS.propertiesPerBoard, 'too many values')
const archiveCardSchema = ProjectCardCreateSchema.omit({ id: true }).extend({
  parentId: z.union([archiveIdSchema, z.literal('')]).default(''),
  values: archiveValueMap,
})
const archiveViewSchema = ProjectViewCreateSchema.omit({ id: true })
const archiveContentSchema = ProjectContentCreateSchema.omit({ id: true }).extend({
  fields: ProjectContentFieldsSchema.extend({ attachmentId: archiveIdSchema.optional() }),
})
const archiveCommentSchema = ProjectCommentCreateSchema.omit({ id: true })

/** The two places a project file can live, passed in so the archive logic stays binding-free. */
export interface ProjectArchiveStorage {
  r2?: R2Bucket
  kv?: KVNamespace
}

function attachmentPath(boardId: string, attachmentId: string): string {
  return `${boardId}/files/${attachmentId}`
}

async function readProjectFile(storage: ProjectArchiveStorage, attachment: ProjectAttachment): Promise<Uint8Array | null> {
  if (attachment.storage === 'kv') {
    const bytes = await storage.kv?.get(attachment.objectKey, 'arrayBuffer')
    return bytes ? new Uint8Array(bytes) : null
  }
  const object = await storage.r2?.get(attachment.objectKey)
  return object ? new Uint8Array(await object.arrayBuffer()) : null
}

async function writeProjectFile(
  storage: ProjectArchiveStorage,
  kind: ProjectAttachment['storage'],
  key: string,
  bytes: Uint8Array,
  mime: string,
): Promise<boolean> {
  if (kind === 'kv') {
    if (!storage.kv) return false
    await storage.kv.put(key, bytes, { metadata: { contentType: mime } })
    return true
  }
  if (!storage.r2) return false
  await storage.r2.put(key, bytes, { httpMetadata: { contentType: mime } })
  return true
}

async function deleteProjectFile(storage: ProjectArchiveStorage, kind: ProjectAttachment['storage'], key: string): Promise<void> {
  if (kind === 'kv') await storage.kv?.delete(key)
  else await storage.r2?.delete(key)
}

function archiveId(value: string, label: string): string {
  if (!isArchiveId(value)) throw ApiError.badRequest(`${label} has an invalid id`)
  return value
}

function assertUniqueArchiveIds(entities: readonly { id: string }[], label: string): void {
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) {
    throw ApiError.badRequest(`archive ${label} ids must be unique`)
  }
}

function assertZipBudget(bytes: Uint8Array): void {
  if (bytes.length > ARCHIVE_MAX_BYTES) throw ApiError.tooLarge('archive is too large')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557 - 22); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { eocd = at; break }
  }
  if (eocd < 0) return
  const count = view.getUint16(eocd + 10, true)
  const offset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || offset === 0xffffffff || count > ARCHIVE_MAX_FILES) throw ApiError.tooLarge('archive has too many files')
  let at = offset
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw ApiError.badRequest('archive directory is invalid')
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    if (compressed === 0xffffffff || size === 0xffffffff) throw ApiError.tooLarge('zip64 archives are not supported')
    total += size
    if (total > ARCHIVE_MAX_UNCOMPRESSED_BYTES) throw ApiError.tooLarge('archive expands beyond the allowed size')
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
}

function archiveFiles(bytes: Uint8Array): Unzipped | null {
  assertZipBudget(bytes)
  try { return unzipSync(bytes) } catch { return null }
}

function assertCompleteBundle(bundle: ProjectBoardBundle): void {
  if (bundle.contentsTruncated || bundle.commentsTruncated) {
    throw ApiError.tooLarge('Archive export is incomplete because the board exceeds the bundle row limit')
  }
}

function zipArchive(entries: Record<string, Uint8Array>): Uint8Array {
  if (Object.keys(entries).length > ARCHIVE_MAX_FILES) throw ApiError.tooLarge('Archive has too many files')
  const uncompressed = Object.values(entries).reduce((total, bytes) => total + bytes.byteLength, 0)
  if (uncompressed > ARCHIVE_MAX_UNCOMPRESSED_BYTES) throw ApiError.tooLarge('Archive expands beyond the allowed size')
  const bytes = zipSync(entries)
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) throw ApiError.tooLarge('Archive is too large')
  return bytes
}

function assertArchiveVersion(files: Unzipped): void {
  const raw = files['version.json']
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(raw))
  } catch {
    throw ApiError.badRequest('archive version.json is invalid')
  }
  if (!ProjectArchiveHeaderSchema.safeParse(parsed).success) {
    throw ApiError.badRequest('archive version.json is invalid')
  }
}

function assertArchiveImport(imported: ReturnType<typeof projectArchiveLinesToImport>): void {
  archiveId(imported.board.id, 'board')
  const boardInput = archiveBoardSchema.safeParse({
    title: imported.board.title,
    description: imported.board.description,
    icon: imported.board.icon,
    showDescription: imported.board.showDescription,
    type: imported.board.type,
    minimumRole: imported.board.minimumRole,
    isTemplate: imported.board.isTemplate,
  })
  if (!boardInput.success) throw ApiError.badRequest('archive board or property schema is invalid')
  if (imported.cards.length > PROJECT_LIMITS.cardsPerBoard) throw ApiError.conflict('PROJECT_MAX_CARDS_PER_BOARD')
  if (imported.views.length > PROJECT_LIMITS.viewsPerBoard) throw ApiError.conflict('PROJECT_MAX_VIEWS_PER_BOARD')
  if (imported.properties.length > PROJECT_LIMITS.propertiesPerBoard) throw ApiError.conflict('PROJECT_MAX_BOARD_PROPERTIES')
  if (imported.contents.length > ARCHIVE_MAX_CONTENTS || imported.comments.length > ARCHIVE_MAX_COMMENTS) {
    throw ApiError.tooLarge('archive has too many rows')
  }
  if (imported.attachments.length > ARCHIVE_MAX_ATTACHMENTS) throw ApiError.tooLarge('archive has too many files')
  assertUniqueArchiveIds(imported.properties, 'property')
  assertUniqueArchiveIds(imported.cards, 'card')
  assertUniqueArchiveIds(imported.views, 'view')
  assertUniqueArchiveIds(imported.contents, 'content')
  assertUniqueArchiveIds(imported.comments, 'comment')
  assertUniqueArchiveIds(imported.attachments, 'attachment')
  const attachmentIds = new Set(imported.attachments.map((attachment) => attachment.id))
  const propertyIds = new Set<string>()
  for (const property of imported.properties) {
    archiveId(property.id, 'property')
    if (!archivePropertySchema.safeParse(property).success || property.type === 'unknown') {
      throw ApiError.badRequest('archive property schema is invalid')
    }
    if (new Set(property.options.map((option) => option.id)).size !== property.options.length) {
      throw ApiError.badRequest('archive property option ids must be unique')
    }
    propertyIds.add(property.id)
  }
  const cardIds = new Set<string>()
  for (const card of imported.cards) {
    archiveId(card.id, 'card')
    if (!archiveCardSchema.safeParse({
      parentId: card.parentId,
      title: card.title,
      icon: card.icon,
      isTemplate: card.isTemplate,
      values: card.values,
      recurrence: card.recurrence,
    }).success) throw ApiError.badRequest('archive card schema is invalid')
    if (Object.keys(card.values).some((propertyId) => !propertyIds.has(propertyId))) {
      throw ApiError.badRequest('archive card value references an unknown property')
    }
    cardIds.add(card.id)
  }
  for (const view of imported.views) {
    archiveId(view.id, 'view')
    if (!archiveViewSchema.safeParse(view).success) throw ApiError.badRequest('archive view schema is invalid')
  }
  for (const content of imported.contents) {
    archiveId(content.id, 'content')
    if (!cardIds.has(content.cardId)) throw ApiError.badRequest('archive content references an unknown card')
    if (content.fields.attachmentId && !attachmentIds.has(content.fields.attachmentId)) {
      throw ApiError.badRequest('archive content references an unknown attachment')
    }
    if (!archiveContentSchema.safeParse(content).success) throw ApiError.badRequest('archive content schema is invalid')
  }
  for (const comment of imported.comments) {
    archiveId(comment.id, 'comment')
    if (!cardIds.has(comment.cardId)) throw ApiError.badRequest('archive comment references an unknown card')
    if (!archiveCommentSchema.safeParse({ body: comment.body }).success) {
      throw ApiError.badRequest('archive comment schema is invalid')
    }
  }
  for (const card of imported.cards) {
    if (card.parentId && !cardIds.has(card.parentId)) throw ApiError.badRequest('archive card references an unknown parent')
    if (card.parentId === card.id) throw ApiError.badRequest('archive card is its own parent')
  }
  if (projectParentMapHasCycle(imported.cards)) throw ApiError.badRequest('archive card hierarchy contains a cycle')
  for (const attachment of imported.attachments) {
    archiveId(attachment.id, 'attachment')
    if (attachment.cardId && !cardIds.has(attachment.cardId)) throw ApiError.badRequest('archive file references an unknown card')
    if (!attachment.path.startsWith(`${imported.board.id}/files/`) || attachment.path.includes('..')) {
      throw ApiError.badRequest('archive file path is outside the board directory')
    }
    if (attachment.size > ARCHIVE_MAX_BYTES) throw ApiError.tooLarge('archive file is too large')
  }
  if (imported.links.length > ARCHIVE_MAX_LINKS) throw ApiError.tooLarge('archive has too many links')
  for (const link of imported.links) {
    if (!cardIds.has(link.fromCardId) || !cardIds.has(link.toCardId)) {
      throw ApiError.badRequest('archive link references an unknown card')
    }
    if (link.fromCardId === link.toCardId) throw ApiError.badRequest('archive link is a self edge')
  }
}

async function collectArchiveAttachments(
  db: D1Database,
  storage: ProjectArchiveStorage,
  boardId: string,
  files: Record<string, Uint8Array>,
): Promise<ProjectArchiveAttachment[]> {
  const out: ProjectArchiveAttachment[] = []
  const attachments = await listBoardAttachments(db, boardId, undefined, PROJECT_LIMITS.attachmentsPerBoard + 1)
  if (attachments.length > PROJECT_LIMITS.attachmentsPerBoard) throw ApiError.tooLarge('Board attachment quota exceeded')
  for (const attachment of attachments) {
    const bytes = await readProjectFile(storage, attachment)
    if (!bytes) throw ApiError.badRequest(`Archive file bytes are unavailable: ${attachment.id}`)
    const path = attachmentPath(boardId, attachment.id)
    files[path] = bytes
    out.push({
      id: attachment.id, cardId: attachment.cardId ?? '', filename: attachment.filename, mime: attachment.mime,
      size: bytes.byteLength, storage: attachment.storage, width: attachment.width, height: attachment.height, path,
    })
  }
  return out
}

export async function exportProjectBoardArchive(
  db: D1Database,
  storage: ProjectArchiveStorage,
  board: ProjectBoard,
  role: ProjectRole,
  viewerId?: string,
): Promise<Uint8Array> {
  const bundle = await readProjectBoardBundle(db, board, role, viewerId)
  assertCompleteBundle(bundle)
  const files: Record<string, Uint8Array> = {}
  const attachments = await collectArchiveAttachments(db, storage, board.id, files)
  const lines = projectBundleToArchiveLines(bundle, await listBoardLinks(db, board.id), attachments)
  return zipArchive({
    'version.json': strToU8(JSON.stringify({ version: PROJECT_ARCHIVE_VERSION, date: Date.now() })),
    [`${board.id}/board.jsonl`]: strToU8(serializeProjectArchiveLines(lines)),
    ...files,
  })
}

/** Whole-account export: one v2 ZIP carrying every readable board's JSONL side by side. */
export async function exportProjectAccountArchive(
  db: D1Database,
  storage: ProjectArchiveStorage,
  userId: string,
): Promise<Uint8Array> {
  const boards = await new ProjectStore(db, userId).boards()
  const files: Record<string, Uint8Array> = {
    'version.json': strToU8(JSON.stringify({ version: PROJECT_ARCHIVE_VERSION, date: Date.now() })),
  }
  for (const board of boards) {
    const bundle = await readProjectBoardBundle(db, board, board.role, userId)
    assertCompleteBundle(bundle)
    const links = await listBoardLinks(db, board.id)
    const attachments = await collectArchiveAttachments(db, storage, board.id, files)
    files[`${board.id}/board.jsonl`] = strToU8(serializeProjectArchiveLines(projectBundleToArchiveLines(bundle, links, attachments)))
  }
  return zipArchive(files)
}

async function discardImportedBoard(
  db: D1Database,
  storage: ProjectArchiveStorage,
  boardId: string,
): Promise<void> {
  for (const attachment of await listBoardAttachments(db, boardId, undefined, PROJECT_LIMITS.attachmentsPerBoard)) {
    await deleteProjectFile(storage, attachment.storage, attachment.objectKey).catch((error: unknown) => {
      console.warn('[inkstone] account import rollback file cleanup failed:', error instanceof Error ? error.message : error)
    })
  }
  await db.batch([
    db.prepare('DELETE FROM project_card_relations WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_card_links WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_sprint_cards WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_time_entries WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_activity WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_automations WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_webhook_deliveries WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_webhooks WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_shares WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_todo_links WHERE card_id IN (SELECT id FROM project_cards WHERE board_id = ?1)').bind(boardId),
    db.prepare('DELETE FROM project_card_values WHERE card_id IN (SELECT id FROM project_cards WHERE board_id = ?1)').bind(boardId),
    db.prepare('DELETE FROM project_comments WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_card_contents WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_attachments WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_cards WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_property_configs WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_properties WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_board_members WHERE board_id = ?1').bind(boardId),
    db.prepare('DELETE FROM project_boards WHERE id = ?1').bind(boardId),
  ])
}

/** Whole-account import: every board.jsonl in the ZIP becomes a fresh board (ids remapped). */
export async function importProjectAccountArchive(
  db: D1Database,
  storage: ProjectArchiveStorage,
  userId: string,
  bytes: Uint8Array,
  now: number,
): Promise<ProjectBoardSummary[]> {
  const files = archiveFiles(bytes)
  if (!files) throw ApiError.badRequest('archive is not a ZIP')
  const jsonlNames = Object.keys(files).filter((name) => name.endsWith('board.jsonl'))
  if (jsonlNames.length === 0) throw ApiError.badRequest('archive ZIP has no board.jsonl')
  assertArchiveVersion(files)
  const created: ProjectBoardSummary[] = []
  try {
    for (const name of jsonlNames) {
      const imported = projectArchiveLinesToImport(parseProjectArchiveLines(strFromU8(files[name]!)))
      assertArchiveImport(imported)
      const attachmentInputs = imported.attachments.map((attachment) => {
        const entry = files[attachment.path]
        if (!entry) throw ApiError.badRequest('archive file is missing from the ZIP')
        if (entry.byteLength !== attachment.size) throw ApiError.badRequest('archive file size does not match')
        return { attachment, bytes: entry }
      })
      const bundle: ProjectBoardBundle = {
        board: {
          id: imported.board.id, ownerId: userId, type: imported.board.type, minimumRole: imported.board.minimumRole as ProjectBoard['minimumRole'],
          title: imported.board.title, description: imported.board.description, icon: imported.board.icon,
          showDescription: imported.board.showDescription, isTemplate: false, templateVersion: 0,
          createdBy: userId, modifiedBy: userId, createAt: now, updateAt: now, deleteAt: 0, archived: false,
        },
        properties: imported.properties,
        views: imported.views.map((view) => ({ ...view, boardId: imported.board.id })),
        cards: imported.cards.map((card) => ({ ...card, boardId: imported.board.id })),
        contents: imported.contents.map((content) => ({ ...content, boardId: imported.board.id })),
        comments: imported.comments.map((comment) => ({ ...comment, boardId: imported.board.id })),
        members: [], links: imported.links, people: {}, role: 'admin', cursor: now, propertyRevision: now,
      }
      const writtenStorage = new Map<string, ProjectAttachment['storage']>()
      created.push(await duplicateProjectBoard(db, bundle, userId, now, {
        rewriteAuthors: true,
        attachments: attachmentInputs,
        onAttachment: async ({ id, attachment, bytes: content }) => {
          const key = projectAttachmentObjectKey(userId, id, attachment.mime, attachment.filename)
          const written = await writeProjectFile(storage, attachment.storage, key, content, attachment.mime)
          if (!written) throw ApiError.badRequest('File storage is not configured')
          writtenStorage.set(key, attachment.storage)
          return key
        },
        onAttachmentError: async (key) => {
          await deleteProjectFile(storage, writtenStorage.get(key) ?? 'r2', key)
        },
      }))
    }
  } catch (error) {
    for (const board of created) await discardImportedBoard(db, storage, board.id).catch((cause: unknown) => {
      console.warn('[inkstone] account import rollback failed:', cause instanceof Error ? cause.message : cause)
    })
    throw error
  }
  return created
}

function linesFromArchiveBytes(bytes: Uint8Array, files: Unzipped | null = archiveFiles(bytes)): ProjectArchiveLine[] {
  if (files) {
    const jsonl = Object.keys(files).find((name) => name.endsWith('board.jsonl'))
    if (!jsonl) throw ApiError.badRequest('archive ZIP has no board.jsonl')
    assertArchiveVersion(files)
    return parseProjectArchiveLines(strFromU8(files[jsonl]!))
  }
  // Not a ZIP: the reference's v1 export is a single JSON object with a blocks array.
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(bytes))
  } catch {
    throw ApiError.badRequest('archive is neither a ZIP nor JSON')
  }
  const header = ProjectArchiveHeaderSchema.safeParse(parsed)
  if (!header.success) throw ApiError.badRequest('archive header is invalid')
  const blocks = (parsed as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) throw ApiError.badRequest('v1 archive has no blocks array')
  const lines: ProjectArchiveLine[] = []
  for (const block of blocks) {
    const result = ProjectArchiveBlockSchema.safeParse(block)
    if (!result.success) throw ApiError.badRequest('v1 archive block is invalid')
    lines.push({ type: 'block', data: result.data })
  }
  return lines
}

export type ProjectArchiveImportResult = { board: ProjectBoardSummary }

export async function importProjectBoardArchive(
  db: D1Database,
  storage: ProjectArchiveStorage,
  userId: string,
  bytes: Uint8Array,
  now: number,
): Promise<ProjectArchiveImportResult> {
  const files = archiveFiles(bytes)
  const imported = projectArchiveLinesToImport(linesFromArchiveBytes(bytes, files))
  assertArchiveImport(imported)
  const source = imported.board
  const existing = await db.prepare('SELECT id FROM project_boards WHERE id = ?1').bind(source.id).first()
  if (existing) throw ApiError.conflict('board id already exists')

  const createAt = source.createAt || now
  const updateAt = source.updateAt || now
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO project_boards
         (id, owner_id, type, minimum_role, title, description, icon, show_description, is_template,
          template_version, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?2, ?2, ?11, ?12, 0)`,
    ).bind(
      source.id, userId, source.type, source.minimumRole, source.title, source.description, source.icon,
      source.showDescription ? 1 : 0, source.isTemplate ? 1 : 0, source.templateVersion, createAt, updateAt,
    ),
    db.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(source.id, userId, 'admin', now),
  ]
  imported.properties.forEach((property, index) => {
    statements.push(db.prepare(
      `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(source.id, property.id, property.name, property.type, JSON.stringify(property.options), index, now))
    statements.push(db.prepare(
      `INSERT OR REPLACE INTO project_property_configs (board_id, property_id, config, updated_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(source.id, property.id, serializeProjectPropertyConfig(property.config), now))
  })
  for (const card of imported.cards) {
    statements.push(db.prepare(
      `INSERT INTO project_cards
         (id, board_id, parent_id, title, icon, is_template, content_order, recurrence, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)`,
    ).bind(
      card.id, source.id, card.parentId, card.title, card.icon, card.isTemplate ? 1 : 0, JSON.stringify(card.contentOrder),
      card.recurrence ? serializeProjectRecurrence(card.recurrence) : null,
      userId, userId, card.createAt || now, card.updateAt || now,
    ))
    for (const [propertyId, value] of Object.entries(card.values)) {
      statements.push(db.prepare(
        'INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(card.id, propertyId, value, now))
    }
  }
  for (const view of imported.views) {
    statements.push(db.prepare(
      `INSERT INTO project_views
         (id, board_id, title, view_type, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`,
    ).bind(
      view.id, source.id, view.title, view.viewType, JSON.stringify(view.fields), view.position,
      userId, userId, view.createAt || now, view.updateAt || now,
    ))
  }
  for (const content of imported.contents) {
    statements.push(db.prepare(
      `INSERT INTO project_card_contents
         (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)`,
    ).bind(
      content.id, content.cardId, source.id, content.type, content.title, JSON.stringify(content.fields), content.position,
      userId, userId, content.createAt || now, content.updateAt || now,
    ))
  }
  for (const comment of imported.comments) {
    statements.push(db.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
    ).bind(comment.id, comment.cardId, source.id, userId, comment.body, comment.createAt || now, comment.updateAt || now))
  }
  for (const link of imported.links) {
    statements.push(db.prepare(
      'INSERT INTO project_card_links (from_card_id, to_card_id, kind, board_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(link.fromCardId, link.toCardId, link.kind, source.id, now))
  }
  const relationTargets = projectRelationTargets(imported.properties)
  for (const card of imported.cards) {
    for (const [propertyId, value] of Object.entries(card.values)) {
      const targetBoardId = relationTargets.get(propertyId)
      if (targetBoardId) statements.push(...relationEdgeStatements(db, source.id, card.id, propertyId, targetBoardId, value, now))
    }
  }
  assertProjectBatchStatementLimit(statements.length + imported.attachments.length)
  const writtenFiles: { storage: ProjectAttachment['storage'], key: string }[] = []
  for (const attachment of imported.attachments) {
    const entry = files?.[attachment.path]
    if (!entry) throw ApiError.badRequest('archive file is missing from the ZIP')
    if (entry.byteLength !== attachment.size) throw ApiError.badRequest('archive file size does not match')
    const objectKey = projectAttachmentObjectKey(userId, attachment.id, attachment.mime, attachment.filename)
    const written = await writeProjectFile(storage, attachment.storage, objectKey, entry, attachment.mime)
    if (!written) throw ApiError.badRequest('File storage is not configured')
    writtenFiles.push({ storage: attachment.storage, key: objectKey })
    statements.push(db.prepare(
      `INSERT INTO project_attachments
         (id, user_id, board_id, card_id, filename, mime, size, storage, object_key, width, height, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
    ).bind(
      attachment.id, userId, source.id, attachment.cardId || null, attachment.filename, attachment.mime,
      entry.byteLength, attachment.storage, objectKey, attachment.width, attachment.height, now,
    ))
  }

  assertProjectBatchStatementLimit(statements.length)
  try {
    await db.batch(statements)
  } catch (error) {
    for (const file of writtenFiles) await deleteProjectFile(storage, file.storage, file.key).catch((cause: unknown) => {
      console.warn('[inkstone] archive import file cleanup failed:', cause)
    })
    throw error
  }
  const board: ProjectBoard = {
    id: source.id, ownerId: userId, type: source.type, minimumRole: source.minimumRole as ProjectBoard['minimumRole'],
    title: source.title, description: source.description, icon: source.icon, showDescription: source.showDescription,
    isTemplate: source.isTemplate, templateVersion: source.templateVersion, createdBy: userId, modifiedBy: userId,
    createAt, updateAt, deleteAt: 0, archived: false,
  }
  return { board: { ...board, role: 'admin' } }
}