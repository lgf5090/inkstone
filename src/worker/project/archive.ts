/**
 * The archive transport: a v2 ZIP out, a v2 ZIP or a v1 JSON in. The JSONL mapping itself lives in
 * the shared module so the browser converters and this server agree byte for byte; this file only
 * zips, unzips, and writes the imported rows. Import preserves the archive's ids (so a round trip is
 * field-equal) but the new board belongs to whoever imports it. Member rows are deliberately not
 * restored: an archive is data, not an invitation, and no local account may join a board because an
 * uploaded file said so.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate'
import type { ProjectBoard, ProjectBoardBundle, ProjectBoardSummary, ProjectRole } from '@shared/project/model'
import {
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveBlockSchema,
  ProjectArchiveHeaderSchema,
  parseProjectArchiveLines,
  serializeProjectArchiveLines,
  type ProjectArchiveLine,
} from '@shared/project/archive'
import { projectArchiveLinesToImport, projectBundleToArchiveLines } from '@shared/project/archive-mapping'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { ApiError } from '../lib/errors'
import { readProjectBoardBundle } from './bundle'
import { duplicateProjectBoard } from './duplicate'
import { ProjectStore } from './store'

const ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
const ARCHIVE_MAX_FILES = 100
const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const ARCHIVE_MAX_CONTENTS = 20000
const ARCHIVE_MAX_COMMENTS = 20000
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function archiveId(value: string, label: string): string {
  if (!ARCHIVE_ID_PATTERN.test(value)) throw ApiError.badRequest(`${label} has an invalid id`)
  return value
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

function assertArchiveImport(imported: ReturnType<typeof projectArchiveLinesToImport>): void {
  archiveId(imported.board.id, 'board')
  if (imported.cards.length > PROJECT_LIMITS.cardsPerBoard) throw ApiError.conflict('PROJECT_MAX_CARDS_PER_BOARD')
  if (imported.views.length > PROJECT_LIMITS.viewsPerBoard) throw ApiError.conflict('PROJECT_MAX_VIEWS_PER_BOARD')
  if (imported.properties.length > PROJECT_LIMITS.propertiesPerBoard) throw ApiError.conflict('PROJECT_MAX_PROPERTIES_PER_BOARD')
  if (imported.contents.length > ARCHIVE_MAX_CONTENTS || imported.comments.length > ARCHIVE_MAX_COMMENTS) {
    throw ApiError.tooLarge('archive has too many rows')
  }
  const cardIds = new Set<string>()
  for (const card of imported.cards) {
    archiveId(card.id, 'card')
    cardIds.add(card.id)
    for (const propertyId of Object.keys(card.values)) archiveId(propertyId, 'property value')
  }
  for (const property of imported.properties) archiveId(property.id, 'property')
  for (const view of imported.views) archiveId(view.id, 'view')
  for (const content of imported.contents) {
    archiveId(content.id, 'content')
    if (!cardIds.has(content.cardId)) throw ApiError.badRequest('archive content references an unknown card')
  }
  for (const comment of imported.comments) {
    archiveId(comment.id, 'comment')
    if (!cardIds.has(comment.cardId)) throw ApiError.badRequest('archive comment references an unknown card')
  }
}

export async function exportProjectBoardArchive(
  db: D1Database,
  board: ProjectBoard,
  role: ProjectRole,
): Promise<Uint8Array> {
  const bundle = await readProjectBoardBundle(db, board, role)
  const lines = projectBundleToArchiveLines(bundle)
  return zipSync({
    'version.json': strToU8(JSON.stringify({ version: PROJECT_ARCHIVE_VERSION, date: Date.now() })),
    [`${board.id}/board.jsonl`]: strToU8(serializeProjectArchiveLines(lines)),
  })
}

/** Whole-account export: one v2 ZIP carrying every readable board's JSONL side by side. */
export async function exportProjectAccountArchive(db: D1Database, userId: string): Promise<Uint8Array> {
  const boards = await new ProjectStore(db, userId).boards()
  const files: Record<string, Uint8Array> = {
    'version.json': strToU8(JSON.stringify({ version: PROJECT_ARCHIVE_VERSION, date: Date.now() })),
  }
  for (const board of boards) {
    const bundle = await readProjectBoardBundle(db, board, board.role)
    files[`${board.id}/board.jsonl`] = strToU8(serializeProjectArchiveLines(projectBundleToArchiveLines(bundle)))
  }
  return zipSync(files)
}

/** Whole-account import: every board.jsonl in the ZIP becomes a fresh board (ids remapped). */
export async function importProjectAccountArchive(db: D1Database, userId: string, bytes: Uint8Array, now: number): Promise<ProjectBoardSummary[]> {
  const files = archiveFiles(bytes)
  if (!files) throw ApiError.badRequest('archive is not a ZIP')
  const jsonlNames = Object.keys(files).filter((name) => name.endsWith('board.jsonl'))
  if (jsonlNames.length === 0) throw ApiError.badRequest('archive ZIP has no board.jsonl')
  const created: ProjectBoardSummary[] = []
  for (const name of jsonlNames) {
    const imported = projectArchiveLinesToImport(parseProjectArchiveLines(strFromU8(files[name]!)))
    assertArchiveImport(imported)
    const bundle: ProjectBoardBundle = {
      board: {
        id: imported.board.id, ownerId: userId, type: imported.board.type, minimumRole: imported.board.minimumRole as ProjectBoard['minimumRole'],
        title: imported.board.title, description: imported.board.description, icon: imported.board.icon,
        showDescription: imported.board.showDescription, isTemplate: false, templateVersion: 0,
        createdBy: userId, modifiedBy: userId, createAt: now, updateAt: now, deleteAt: 0, archived: false,
      },
      properties: imported.properties,
      views: imported.views.map((view) => ({ ...view, boardId: imported.board.id })),
      cards: imported.cards.map((card) => ({ ...card, parentId: '', boardId: imported.board.id })),
      contents: imported.contents.map((content) => ({ ...content, boardId: imported.board.id })),
      comments: imported.comments.map((comment) => ({ ...comment, boardId: imported.board.id })),
      members: [], people: {}, role: 'admin', cursor: now,
    }
    created.push(await duplicateProjectBoard(db, bundle, userId, now))
  }
  return created
}

function linesFromArchiveBytes(bytes: Uint8Array): ProjectArchiveLine[] {
  const files: Unzipped | null = archiveFiles(bytes)
  if (files) {
    const jsonl = Object.keys(files).find((name) => name.endsWith('board.jsonl'))
    if (!jsonl) throw ApiError.badRequest('archive ZIP has no board.jsonl')
    const versionRaw = files['version.json']
    if (versionRaw) {
      const header = ProjectArchiveHeaderSchema.safeParse(JSON.parse(strFromU8(versionRaw)))
      if (!header.success) throw ApiError.badRequest('archive version.json is invalid')
    }
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

// D1 caps a batch at 1000 statements; a large board can exceed that, so the import runs in chunks.
const IMPORT_BATCH_SIZE = 500

export async function importProjectBoardArchive(
  db: D1Database,
  userId: string,
  bytes: Uint8Array,
  now: number,
): Promise<ProjectArchiveImportResult> {
  const imported = projectArchiveLinesToImport(linesFromArchiveBytes(bytes))
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
  })
  for (const card of imported.cards) {
    statements.push(db.prepare(
      `INSERT INTO project_cards
         (id, board_id, parent_id, title, icon, is_template, content_order, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`,
    ).bind(
      card.id, source.id, card.title, card.icon, card.isTemplate ? 1 : 0, JSON.stringify(card.contentOrder),
      card.createdBy || userId, card.modifiedBy || userId, card.createAt || now, card.updateAt || now,
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
      view.createdBy || userId, view.modifiedBy || userId, view.createAt || now, view.updateAt || now,
    ))
  }
  for (const content of imported.contents) {
    statements.push(db.prepare(
      `INSERT INTO project_card_contents
         (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)`,
    ).bind(
      content.id, content.cardId, source.id, content.type, content.title, JSON.stringify(content.fields), content.position,
      content.createdBy || userId, content.modifiedBy || userId, content.createAt || now, content.updateAt || now,
    ))
  }
  for (const comment of imported.comments) {
    statements.push(db.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
    ).bind(comment.id, comment.cardId, source.id, comment.authorId || userId, comment.body, comment.createAt || now, comment.updateAt || now))
  }

  for (let index = 0; index < statements.length; index += IMPORT_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + IMPORT_BATCH_SIZE))
  }
  const board: ProjectBoard = {
    id: source.id, ownerId: userId, type: source.type, minimumRole: source.minimumRole as ProjectBoard['minimumRole'],
    title: source.title, description: source.description, icon: source.icon, showDescription: source.showDescription,
    isTemplate: source.isTemplate, templateVersion: source.templateVersion, createdBy: userId, modifiedBy: userId,
    createAt, updateAt, deleteAt: 0, archived: false,
  }
  return { board: { ...board, role: 'admin' } }
}