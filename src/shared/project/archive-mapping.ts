/**
 * Maps between this port's bundle and the reference's archive blocks, field for field, so an export
 * here imports there and vice versa. The reference keeps a card's property values in
 * `fields.properties` (multi-valued types as arrays), a view's type inside `fields.viewType`, a
 * comment's text in `title`, and a checkbox state in `fields.value`; this port stores them as value
 * rows, a top-level viewType, a body column and `fields.checked`. These two functions are the only
 * place that translation lives, and the round-trip test pins them against each other.
 */
import type {
  ProjectBoardBundle,
  ProjectCardLink,
  ProjectContent,
  ProjectContentType,
  ProjectProperty,
  ProjectRecurrence,
  ProjectViewFields,
  ProjectViewType,
} from './model'
import { emptyProjectViewFields, PROJECT_CONTENT_TYPES, PROJECT_PROPERTY_TYPES, PROJECT_VIEW_TYPES } from './model'
import {
  projectArchiveBlockIsBoard, ProjectArchiveError,
  type ProjectArchiveAttachment, type ProjectArchiveBlock, type ProjectArchiveLine,
} from './archive'
import { ProjectRecurrenceSchema } from './validation'
import { parseProjectPropertyConfig } from './property-config'

const MULTI_VALUE_TYPES = new Set(['multiSelect', 'multiPerson', 'relation'])

/** A stored value is text; the reference wants an array for the two multi-valued property types. */
function exportValue(value: string, propertyType: string | undefined): string | string[] {
  if (propertyType && MULTI_VALUE_TYPES.has(propertyType)) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // A non-JSON scalar is a legitimate single value; fall through and keep it as text.
    }
  }
  return value
}

function importValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(String))
  return value === undefined || value === null ? '' : String(value)
}

function blockStamps(entity: { createdBy: string; modifiedBy: string; createAt: number; updateAt: number; deleteAt: number }) {
  return {
    createdBy: entity.createdBy,
    modifiedBy: entity.modifiedBy,
    createAt: entity.createAt,
    updateAt: entity.updateAt,
    deleteAt: entity.deleteAt,
  }
}

export function projectBundleToArchiveLines(
  bundle: ProjectBoardBundle,
  links: readonly ProjectCardLink[] = [],
  attachments: readonly ProjectArchiveAttachment[] = [],
): ProjectArchiveLine[] {
  const { board, properties, cards, views, contents, comments, members } = bundle
  const propertyTypes = new Map(properties.map((property) => [property.id, property.type as string]))
  const lines: ProjectArchiveLine[] = [
    {
      type: 'board',
      data: {
        id: board.id,
        title: board.title,
        description: board.description,
        icon: board.icon,
        showDescription: board.showDescription,
        type: board.type,
        minimumRole: board.minimumRole,
        isTemplate: board.isTemplate,
        templateVersion: board.templateVersion,
        ownerId: board.ownerId,
        cardProperties: properties,
        ...blockStamps(board),
      },
    },
  ]
  for (const card of cards) {
    const values: Record<string, string | string[]> = {}
    for (const [propertyId, value] of Object.entries(card.values)) {
      if (propertyTypes.get(propertyId) === 'formula' || propertyTypes.get(propertyId) === 'rollup') continue
      values[propertyId] = exportValue(value, propertyTypes.get(propertyId))
    }
    lines.push({
      type: 'block',
      data: {
        id: card.id, type: 'card', parentId: board.id, boardId: board.id, title: card.title,
        fields: {
          icon: card.icon, isTemplate: card.isTemplate, properties: values, contentOrder: card.contentOrder,
          parentId: card.parentId, recurrence: card.recurrence ?? null,
        },
        ...blockStamps(card),
      },
    })
  }
  for (const view of views) {
    lines.push({
      type: 'block',
      data: {
        id: view.id, type: 'view', parentId: board.id, boardId: board.id, title: view.title,
        fields: { viewType: view.viewType, ...view.fields },
        ...blockStamps(view),
      },
    })
  }
  for (const content of contents) {
    lines.push({ type: 'block', data: contentToBlock(content) })
  }
  for (const comment of comments) {
    lines.push({
      type: 'block',
      data: {
        id: comment.id, type: 'comment', parentId: comment.cardId, boardId: comment.boardId, title: comment.body,
        fields: {}, createdBy: comment.authorId, modifiedBy: comment.authorId,
        createAt: comment.createAt, updateAt: comment.updateAt, deleteAt: comment.deleteAt,
      },
    })
  }
  for (const member of members) {
    lines.push({ type: 'boardMember', data: { boardId: board.id, userId: member.userId, role: member.role } })
  }
  for (const link of links) {
    lines.push({ type: 'cardLink', data: { fromCardId: link.fromCardId, toCardId: link.toCardId, kind: link.kind } })
  }
  for (const attachment of attachments) {
    lines.push({ type: 'attachment', data: attachment })
  }
  return lines
}

function contentToBlock(content: ProjectContent): ProjectArchiveBlock {
  const fields: Record<string, unknown> = { ...content.fields }
  if (content.type === 'checkbox') {
    fields.value = content.fields.checked ?? false
    delete fields.checked
  }
  return {
    id: content.id, type: content.type, parentId: content.cardId, boardId: content.boardId, title: content.title,
    fields, createdBy: content.createdBy, modifiedBy: content.modifiedBy,
    createAt: content.createAt, updateAt: content.updateAt, deleteAt: content.deleteAt,
  }
}

export interface ProjectArchiveImportStamps {
  createdBy: string
  modifiedBy: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectArchiveImportCard extends ProjectArchiveImportStamps {
  id: string
  parentId: string
  title: string
  icon: string
  isTemplate: boolean
  contentOrder: (string | string[])[]
  recurrence: ProjectRecurrence | null
  values: Record<string, string>
}

export interface ProjectArchiveImportView extends ProjectArchiveImportStamps {
  id: string
  title: string
  viewType: ProjectViewType
  fields: ProjectViewFields
  position: number
}

export interface ProjectArchiveImportContent extends ProjectArchiveImportStamps {
  id: string
  cardId: string
  type: ProjectContentType
  title: string
  fields: ProjectContent['fields']
  position: number
}

export interface ProjectArchiveImportComment {
  id: string
  cardId: string
  authorId: string
  body: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectArchiveBoardImport {
  board: ProjectArchiveImportStamps & {
    id: string
    title: string
    description: string
    icon: string
    showDescription: boolean
    type: 'O' | 'P'
    minimumRole: string
    isTemplate: boolean
    templateVersion: number
    ownerId: string
  }
  properties: ProjectProperty[]
  cards: ProjectArchiveImportCard[]
  views: ProjectArchiveImportView[]
  contents: ProjectArchiveImportContent[]
  comments: ProjectArchiveImportComment[]
  members: { userId: string; role: string }[]
  links: ProjectCardLink[]
  attachments: ProjectArchiveImportAttachment[]
}

export interface ProjectArchiveImportAttachment {
  id: string
  cardId: string
  filename: string
  mime: string
  size: number
  storage: 'r2' | 'kv'
  width: number | null
  height: number | null
  path: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readStamps(data: Record<string, unknown>): ProjectArchiveImportStamps {
  return {
    createdBy: asString(data.createdBy),
    modifiedBy: asString(data.modifiedBy),
    createAt: asNumber(data.createAt),
    updateAt: asNumber(data.updateAt),
    deleteAt: asNumber(data.deleteAt),
  }
}

function readProperties(value: unknown): ProjectProperty[] {
  if (!Array.isArray(value)) return []
  const out: ProjectProperty[] = []
  for (const item of value) {
    const record = asRecord(item)
    const id = asString(record.id)
    if (!id) continue
    const type = asString(record.type)
    const options = Array.isArray(record.options)
      ? record.options.map((option) => {
        const opt = asRecord(option)
        return { id: asString(opt.id), value: asString(opt.value), color: asString(opt.color) }
      })
      : []
    const config = parseProjectPropertyConfig(JSON.stringify(record.config ?? {}))
    out.push({
      id,
      name: asString(record.name),
      type: (PROJECT_PROPERTY_TYPES as readonly string[]).includes(type) ? (type as ProjectProperty['type']) : 'unknown',
      options,
      ...(config ? { config } : {}),
    })
  }
  return out
}

/** The reference's heading/list/quote blocks collapse to Markdown text here (D-09); the body is kept. */
function readContent(block: ProjectArchiveBlock, position: number): ProjectArchiveImportContent {
  const fields = asRecord(block.fields)
  let type = block.type as ProjectContentType
  let title = block.title
  if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
    type = 'text'
    title = `${'#'.repeat(Number(block.type[1]))} ${block.title}`
  } else if (block.type === 'list-item') {
    type = 'text'
    title = `- ${block.title}`
  } else if (block.type === 'quote') {
    type = 'text'
    title = `> ${block.title}`
  } else if (!(PROJECT_CONTENT_TYPES as readonly string[]).includes(block.type)) {
    type = 'text'
  }
  const mapped: ProjectContent['fields'] = {}
  if (type === 'checkbox') mapped.checked = fields.value === true
  const attachmentId = asString(fields.attachmentId) || asString(fields.fileId)
  if (attachmentId) mapped.attachmentId = attachmentId
  if (typeof fields.language === 'string') mapped.language = fields.language
  return {
    id: block.id, cardId: block.parentId, type, title, fields: mapped, position,
    ...readStamps(block),
  }
}

function readRecurrence(value: unknown): ProjectRecurrence | null {
  const parsed = ProjectRecurrenceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function readContentOrder(value: unknown): (string | string[])[] {
  if (!Array.isArray(value)) return []
  const out: (string | string[])[] = []
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry)
    else if (Array.isArray(entry)) out.push(entry.filter((member): member is string => typeof member === 'string'))
  }
  return out
}

/**
 * Read an archive into the rows the importer will write. Deleted blocks are dropped: an export only
 * ever carries live entities (the bundle excludes the trash), so skipping them keeps a round trip
 * clean and never resurrects deleted data on import.
 */
export function projectArchiveLinesToImport(lines: readonly ProjectArchiveLine[]): ProjectArchiveBoardImport {
  let boardData: Record<string, unknown> | null = null
  const blocks: ProjectArchiveBlock[] = []
  const members: { userId: string; role: string }[] = []
  const links: ProjectCardLink[] = []
  const attachments: ProjectArchiveImportAttachment[] = []
  for (const line of lines) {
    if (line.type === 'board') {
      boardData = asRecord(line.data)
    } else if (line.type === 'boardMember') {
      const userId = asString(line.data.userId)
      if (userId) members.push({ userId, role: asString(line.data.role) })
    } else if (line.type === 'cardLink') {
      links.push({ fromCardId: line.data.fromCardId, toCardId: line.data.toCardId, kind: line.data.kind })
    } else if (line.type === 'attachment') {
      attachments.push({
        id: line.data.id, cardId: line.data.cardId, filename: line.data.filename, mime: line.data.mime,
        size: line.data.size, storage: line.data.storage, width: line.data.width, height: line.data.height,
        path: line.data.path,
      })
    } else if (projectArchiveBlockIsBoard(line.data)) {
      const block = line.data
      boardData = {
        ...asRecord(block.fields),
        id: block.id, title: block.title,
        createdBy: block.createdBy, modifiedBy: block.modifiedBy,
        createAt: block.createAt, updateAt: block.updateAt, deleteAt: block.deleteAt,
      }
    } else {
      blocks.push(line.data)
    }
  }
  if (!boardData) throw new ProjectArchiveError('archive has no board', 0)

  const minimumRole = asString(boardData.minimumRole)
  const board = {
    id: asString(boardData.id),
    title: asString(boardData.title),
    description: asString(boardData.description),
    icon: asString(boardData.icon),
    showDescription: boardData.showDescription === true,
    type: (boardData.type === 'O' ? 'O' : 'P') as 'O' | 'P',
    minimumRole: ['viewer', 'commenter', 'editor', 'admin'].includes(minimumRole) ? minimumRole : '',
    isTemplate: boardData.isTemplate === true,
    templateVersion: asNumber(boardData.templateVersion),
    ownerId: asString(boardData.ownerId),
    ...readStamps(boardData),
  }
  const properties = readProperties(boardData.cardProperties)

  const cards: ProjectArchiveImportCard[] = []
  const views: ProjectArchiveImportView[] = []
  const contents: ProjectArchiveImportContent[] = []
  const comments: ProjectArchiveImportComment[] = []
  const contentPosition = new Map<string, number>()
  let viewPosition = 0
  for (const block of blocks) {
    if (block.deleteAt !== 0) continue
    const fields = asRecord(block.fields)
    if (block.type === 'card') {
      const values: Record<string, string> = {}
      for (const [propertyId, value] of Object.entries(asRecord(fields.properties))) {
        values[propertyId] = importValue(value)
      }
      cards.push({
        id: block.id, parentId: asString(fields.parentId), title: block.title, icon: asString(fields.icon),
        isTemplate: fields.isTemplate === true, contentOrder: readContentOrder(fields.contentOrder),
        recurrence: readRecurrence(fields.recurrence), values, ...readStamps(block),
      })
    } else if (block.type === 'view') {
      const viewType = asString(fields.viewType)
      const viewFields: Record<string, unknown> = { ...emptyProjectViewFields(), ...fields }
      // viewType travels inside fields in the archive but is a top-level column here; drop the duplicate.
      delete viewFields.viewType
      views.push({
        id: block.id, title: block.title,
        viewType: (PROJECT_VIEW_TYPES as readonly string[]).includes(viewType) ? (viewType as ProjectViewType) : 'board',
        fields: viewFields as unknown as ProjectViewFields,
        position: viewPosition, ...readStamps(block),
      })
      viewPosition += 1
    } else if (block.type === 'comment') {
      comments.push({
        id: block.id, cardId: block.parentId, authorId: block.createdBy, body: block.title,
        createAt: block.createAt, updateAt: block.updateAt, deleteAt: block.deleteAt,
      })
    } else {
      const position = contentPosition.get(block.parentId) ?? 0
      contents.push(readContent(block, position))
      contentPosition.set(block.parentId, position + 1)
    }
  }
  return { board, properties, cards, views, contents, comments, members, links, attachments }
}