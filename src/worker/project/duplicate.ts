/**
 * Copying a board or a card. A copy gets fresh ids for the board and every child row (those are global
 * primary keys) but keeps property and option ids (those are board-scoped), so the references that need
 * rewriting are the ones pointing at cards, contents and comments: a card's parent and contentOrder, a
 * view's cardOrder and its default template, and the dependency edges between copied cards. Members and
 * share links are deliberately not copied. Attachments stay with the original: a copied row would point
 * at the same storage object, and deleting either copy would take the object away from the other.
 */
import type { ProjectAttachment, ProjectBoardBundle, ProjectBoardSummary, ProjectCard, ProjectCardLink, ProjectViewFields } from '@shared/project/model'
import type { ProjectContentOrder } from '@shared/project/content-order'
import { newProjectId } from '@shared/project/limits'
import { serializeProjectRecurrence } from '@shared/project/recurrence'
import { rowToContent, type ContentRow } from './bundle'

const COPY_BATCH_SIZE = 500

type AttachmentSource = Pick<ProjectAttachment, 'cardId' | 'filename' | 'mime' | 'storage' | 'width' | 'height'>

function remapId(map: Map<string, string>, id: string): string {
  return map.get(id) ?? id
}

function remapContentOrder(order: ProjectContentOrder, map: Map<string, string>): ProjectContentOrder {
  return order.map((entry) => (typeof entry === 'string' ? remapId(map, entry) : entry.map((id) => remapId(map, id))))
}

function remapViewFields(fields: ProjectViewFields, cardMap: Map<string, string>): ProjectViewFields {
  return {
    ...fields,
    cardOrder: fields.cardOrder.map((id) => remapId(cardMap, id)),
    defaultTemplateId: remapId(cardMap, fields.defaultTemplateId),
  }
}

export async function duplicateProjectBoard(
  db: D1Database,
  bundle: ProjectBoardBundle,
  userId: string,
  now: number,
  options: {
    includeComments?: boolean
    attachments?: readonly { attachment: AttachmentSource, bytes: Uint8Array }[]
    onAttachment?: (input: { id: string, cardId: string | null, attachment: AttachmentSource, bytes: Uint8Array }) => Promise<string | null>
  } = {},
): Promise<ProjectBoardSummary> {
  const source = bundle.board
  const boardId = newProjectId('board')
  const cardMap = new Map(bundle.cards.map((card) => [card.id, newProjectId('card')]))
  const viewMap = new Map(bundle.views.map((view) => [view.id, newProjectId('view')]))
  const contentMap = new Map(bundle.contents.map((content) => [content.id, newProjectId('content')]))
  const commentMap = new Map(bundle.comments.map((comment) => [comment.id, newProjectId('comment')]))
  const childMap = new Map([...contentMap, ...commentMap])
  const links = bundle.links ?? (await db
    .prepare('SELECT from_card_id, to_card_id, kind FROM project_card_links WHERE board_id = ?1')
    .bind(source.id)
    .all<{ from_card_id: string, to_card_id: string, kind: string }>()).results.map((row) => ({
    fromCardId: row.from_card_id, toCardId: row.to_card_id, kind: row.kind as ProjectCardLink['kind'],
  }))

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO project_boards
         (id, owner_id, type, minimum_role, title, description, icon, show_description, is_template,
          template_version, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?2, ?2, ?9, ?9, 0)`,
    ).bind(
      boardId, userId, source.type, source.minimumRole, source.title, source.description, source.icon,
      source.showDescription ? 1 : 0, now,
    ),
    db.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(boardId, userId, 'admin', now),
  ]
  bundle.properties.forEach((property, index) => {
    statements.push(db.prepare(
      `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(boardId, property.id, property.name, property.type, JSON.stringify(property.options), index, now))
  })
  for (const card of bundle.cards) {
    const id = cardMap.get(card.id)!
    statements.push(db.prepare(
      `INSERT INTO project_cards
         (id, board_id, parent_id, title, icon, is_template, content_order, recurrence, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?10, 0)`,
    ).bind(
      id, boardId, card.parentId ? cardMap.get(card.parentId) ?? '' : '', card.title, card.icon,
      card.isTemplate ? 1 : 0, JSON.stringify(remapContentOrder(card.contentOrder, childMap)),
      card.recurrence ? serializeProjectRecurrence(card.recurrence) : null, userId, now,
    ))
    for (const [propertyId, value] of Object.entries(card.values)) {
      statements.push(db.prepare(
        'INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(id, propertyId, value, now))
    }
  }
  for (const view of bundle.views) {
    statements.push(db.prepare(
      `INSERT INTO project_views
         (id, board_id, title, view_type, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?8, 0)`,
    ).bind(viewMap.get(view.id)!, boardId, view.title, view.viewType, JSON.stringify(remapViewFields(view.fields, cardMap)), view.position, userId, now))
  }
  for (const content of bundle.contents) {
    statements.push(db.prepare(
      `INSERT INTO project_card_contents
         (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, 0)`,
    ).bind(contentMap.get(content.id)!, remapId(cardMap, content.cardId), boardId, content.type, content.title, JSON.stringify(content.fields), content.position, userId, now))
  }
  for (const link of links) {
    const from = cardMap.get(link.fromCardId)
    const to = cardMap.get(link.toCardId)
    if (!from || !to) continue
    statements.push(db.prepare(
      'INSERT INTO project_card_links (from_card_id, to_card_id, kind, board_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(from, to, link.kind, boardId, now))
  }
  for (const item of options.attachments ?? []) {
    if (!options.onAttachment) continue
    const cardId = item.attachment.cardId ? cardMap.get(item.attachment.cardId) ?? null : null
    if (item.attachment.cardId && !cardId) continue
    const attachmentId = newProjectId('attachment')
    const objectKey = await options.onAttachment({ id: attachmentId, cardId, attachment: item.attachment, bytes: item.bytes })
    if (!objectKey) continue
    statements.push(db.prepare(
      `INSERT INTO project_attachments
         (id, user_id, board_id, card_id, filename, mime, size, storage, object_key, width, height, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
    ).bind(
      attachmentId, userId, boardId, cardId, item.attachment.filename, item.attachment.mime,
      item.bytes.byteLength, item.attachment.storage, objectKey, item.attachment.width, item.attachment.height, now,
    ))
  }
  if (options.includeComments !== false) {
    for (const comment of bundle.comments) {
      statements.push(db.prepare(
        `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)`,
      ).bind(commentMap.get(comment.id)!, remapId(cardMap, comment.cardId), boardId, comment.authorId, comment.body, now))
    }
  }
  for (let index = 0; index < statements.length; index += COPY_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + COPY_BATCH_SIZE))
  }
  return {
    id: boardId, ownerId: userId, type: source.type, minimumRole: source.minimumRole, title: source.title,
    description: source.description, icon: source.icon, showDescription: source.showDescription,
    isTemplate: false, templateVersion: 0, createdBy: userId, modifiedBy: userId, createAt: now, updateAt: now,
    deleteAt: 0, archived: false, role: 'admin',
  }
}

/**
 * A card copy carries its values and content blocks but not its comments: a comment is conversation,
 * not content, so the copy starts a fresh thread. The contentOrder keeps only the copied blocks.
 */
export async function duplicateProjectCard(
  db: D1Database,
  card: ProjectCard,
  userId: string,
  now: number,
): Promise<ProjectCard> {
  const { results } = await db
    .prepare('SELECT * FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0 ORDER BY position, id')
    .bind(card.id)
    .all<ContentRow>()
  const contents = results.map(rowToContent)
  const cardId = newProjectId('card')
  const contentMap = new Map(contents.map((content) => [content.id, newProjectId('content')]))
  const contentOrder: ProjectContentOrder = card.contentOrder
    .map((entry): string | string[] | null => {
      if (typeof entry === 'string') return contentMap.get(entry) ?? null
      const group = entry.map((id) => contentMap.get(id)).filter((id): id is string => Boolean(id))
      return group.length ? group : null
    })
    .filter((entry): entry is string | string[] => entry !== null)
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO project_cards
         (id, board_id, parent_id, title, icon, is_template, content_order, recurrence, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?8, ?9, ?9, 0)`,
    ).bind(
      cardId, card.boardId, card.parentId, card.title, card.icon, JSON.stringify(contentOrder),
      card.recurrence ? serializeProjectRecurrence(card.recurrence) : null, userId, now,
    ),
  ]
  for (const [propertyId, value] of Object.entries(card.values)) {
    statements.push(db.prepare(
      'INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(cardId, propertyId, value, now))
  }
  contents.forEach((content, index) => {
    statements.push(db.prepare(
      `INSERT INTO project_card_contents
         (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, 0)`,
    ).bind(contentMap.get(content.id)!, cardId, card.boardId, content.type, content.title, JSON.stringify(content.fields), index, userId, now))
  })
  await db.batch(statements)
  return {
    id: cardId, boardId: card.boardId, parentId: card.parentId, title: card.title, icon: card.icon, isTemplate: false,
    contentOrder, values: card.values, recurrence: card.recurrence, createdBy: userId, modifiedBy: userId,
    createAt: now, updateAt: now, deleteAt: 0,
  }
}