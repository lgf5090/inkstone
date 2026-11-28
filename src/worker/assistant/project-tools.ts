/**
 * The project boards and cards the assistant can act on.
 *
 * Every tool resolves the board through `ProjectStore.boards()`, which is the same read the app's own
 * list uses and already folds the owner rule, the open-board minimum and the membership role into one
 * answer. A board that read does not return is a board this account cannot see, so the tool refuses it
 * without ever naming it — the model gets "not found", never "forbidden", exactly as the HTTP boundary
 * answers. Writes need editor; the roster and settings stay with the app.
 */
import type { ProjectBoardSummary, ProjectCard, ProjectProperty, ProjectRole } from '@shared/project/model'
import { projectRoleAtLeast } from '@shared/project/model'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { projectInputToStamp } from '@shared/project/date'
import { ProjectStore } from '../project/store'
import { createProjectCard, getProjectCard, patchProjectCard, softDeleteProjectCard } from '../project/cards'
import { createProjectContent } from '../project/contents'
import { getProjectBoardRow, readBoardProperties } from '../project/boards'
import { projectCardForRole, projectPropertiesForRole } from '../project/visibility'
import { ApiError } from '../lib/errors'
import { ToolError, type PreparedTarget, type ToolContext, type ToolDefinition } from './tools'

const MAX_LISTED_CARDS = 200

async function ask<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof ApiError) throw new ToolError(error.message)
    throw error
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('A non-empty string is required.')
  return value.trim().slice(0, max)
}

/** The board and the caller's role, or a refusal that does not confirm the board exists. */
async function boardFor(ctx: ToolContext, boardId: string, required: ProjectRole): Promise<ProjectBoardSummary> {
  const boards = await ask(() => new ProjectStore(ctx.env.DB, ctx.store.userId).boards())
  const found = boards.find((entry) => entry.id === boardId)
  if (!found) throw new ToolError(`Board "${boardId.slice(0, 40)}" does not exist or is not visible to this account.`)
  if (!projectRoleAtLeast(found.role, required)) throw new ToolError(`This account is ${found.role} on that board; ${required} is required.`)
  return found
}

async function cardBoard(ctx: ToolContext, cardId: string, required: ProjectRole): Promise<{ card: ProjectCard, board: ProjectBoardSummary }> {
  const card = await ask(() => getProjectCard(ctx.env.DB, cardId))
  if (!card || card.deleteAt !== 0) throw new ToolError('Card not found.')
  const board = await boardFor(ctx, card.boardId, required)
  return { card, board }
}

/** The board row the store functions expect, resolved after the role check has already passed. */
async function boardRow(ctx: ToolContext, boardId: string) {
  const row = await ask(() => getProjectBoardRow(ctx.env.DB, boardId))
  if (!row) throw new ToolError('Board not found.')
  return row
}

function presentCard(card: ProjectCard, properties?: readonly ProjectProperty[], role?: ProjectRole) {
  const visible = properties && role ? projectCardForRole(card, properties, role) : card
  return { id: visible.id, title: visible.title, board_id: visible.boardId, parent_id: visible.parentId || null, values: visible.values }
}

export const PROJECT_BOARD_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'project_list_boards',
    description: 'List the project boards this account can open, with ids, titles and the role it holds. Call this before acting on a board unless the page context already names one.',
    permission: 'read',
    fields: {},
    async run(_args, ctx) {
      const boards = await ask(() => new ProjectStore(ctx.env.DB, ctx.store.userId).boards())
      return { boards: boards.map((board) => ({ id: board.id, title: board.title, role: board.role })) }
    },
  },
  {
    name: 'project_list_cards',
    description: 'List the cards on one project board, with their property values. Use it to see what is on the board before answering or changing it.',
    permission: 'read',
    fields: {
      boardId: { type: 'string', description: 'Board id from project_list_boards.', maxLength: 64 },
      limit: { type: 'integer', description: `Maximum cards, 1–${MAX_LISTED_CARDS}. Default 50.`, minimum: 1, maximum: MAX_LISTED_CARDS, optional: true },
    },
    async run(args, ctx) {
      const boardId = text(args.boardId, 64)
      const board = await boardFor(ctx, boardId, 'viewer')
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_CARDS, Math.max(1, args.limit)) : 50
      const { results } = await ctx.env.DB
        .prepare('SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ORDER BY create_at, id LIMIT ?2')
        .bind(boardId, limit).all<{ id: string }>()
      const cards = await Promise.all(results.map((row) => getProjectCard(ctx.env.DB, row.id)))
      const properties = projectPropertiesForRole(await ask(() => readBoardProperties(ctx.env.DB, boardId)), board.role)
      return {
        properties: properties.map((property) => ({ id: property.id, name: property.name, type: property.type, options: property.options.map((option) => ({ id: option.id, value: option.value })) })),
        cards: cards.filter((card): card is ProjectCard => card !== null).map((card) => presentCard(card, properties, board.role)),
      }
    },
  },
  {
    name: 'project_create_card',
    description: 'Create a card on a project board. Pass parentId to file it as a subtask of another card on the same board.',
    permission: 'write',
    fields: {
      boardId: { type: 'string', description: 'Board id from project_list_boards.', maxLength: 64 },
      title: { type: 'string', description: 'Card title.', maxLength: 500 },
      parentId: { type: 'string', description: 'Parent card id when this is a subtask.', maxLength: 64, optional: true },
    },
    async run(args, ctx) {
      const boardId = text(args.boardId, 64)
      await boardFor(ctx, boardId, 'editor')
      const parentId = typeof args.parentId === 'string' && args.parentId.trim() ? args.parentId.trim().slice(0, 64) : ''
      if (parentId) {
        const parent = await ask(() => getProjectCard(ctx.env.DB, parentId))
        if (!parent || parent.boardId !== boardId || parent.deleteAt !== 0) throw new ToolError('The parent card is not on this board.')
      }
      const row = await boardRow(ctx, boardId)
      const card = await ask(() => createProjectCard(ctx.env.DB, row, ctx.store.userId, { title: text(args.title, 500), parentId, icon: '', isTemplate: false, values: {} }, ctx.now ?? Date.now()))
      return { created: presentCard(card) }
    },
  },
  {
    name: 'project_create_card_from_note',
    description: 'Create a project card from one of the user’s notes, copying the note body into a Markdown content block. Use this for meeting notes and action items.',
    permission: 'write',
    fields: {
      boardId: { type: 'string', description: 'Board id from project_list_boards.', maxLength: 64 },
      noteId: { type: 'string', description: 'Note id owned by the current account.', maxLength: 64 },
      title: { type: 'string', description: 'Optional card title; defaults to the note title.', maxLength: 500, optional: true },
    },
    async run(args, ctx) {
      const boardId = text(args.boardId, 64)
      const noteId = text(args.noteId, 64)
      await boardFor(ctx, boardId, 'editor')
      const note = await ask(() => ctx.env.DB.prepare(
        'SELECT id, title, content, is_encrypted, deleted_at FROM notes WHERE id = ?1 AND user_id = ?2',
      ).bind(noteId, ctx.store.userId).first<{ id: string, title: string, content: string, is_encrypted: number, deleted_at: number | null }>())
      if (!note || note.deleted_at !== null) throw new ToolError('Note not found.')
      if (note.is_encrypted === 1) throw new ToolError('This note is locked; unlock it before creating a card from it.')
      const row = await boardRow(ctx, boardId)
      const now = ctx.now ?? Date.now()
      const card = await ask(() => createProjectCard(ctx.env.DB, row, ctx.store.userId, {
        title: typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 500) : note.title.slice(0, 500),
        parentId: '', icon: '', isTemplate: false, values: {},
      }, now))
      const characters = Array.from(note.content)
      const truncated = characters.length > PROJECT_LIMITS.fieldsRunes
      try {
        await ask(() => createProjectContent(ctx.env.DB, card, ctx.store.userId, {
          type: 'text', title: characters.slice(0, PROJECT_LIMITS.fieldsRunes).join(''), fields: { language: 'md' },
        }, now))
      } catch (error) {
        await ask(() => softDeleteProjectCard(ctx.env.DB, card.id, ctx.store.userId, now))
        throw error
      }
      return { created: presentCard(card), noteId, bodyTruncated: truncated }
    },
  },
  {
    name: 'project_update_card',
    description: 'Rename a project card or set one of its property values. Read project_list_cards first to learn the property and option ids.',
    permission: 'write',
    fields: {
      cardId: { type: 'string', description: 'Card id from project_list_cards.', maxLength: 64 },
      title: { type: 'string', description: 'New title.', maxLength: 500, optional: true },
      propertyId: { type: 'string', description: 'Property to set, with value.', maxLength: 64, optional: true },
      value: { type: 'string', description: 'Value for propertyId; an option id for a select. Empty clears it.', maxLength: 2000, optional: true },
    },
    async run(args, ctx) {
      const { card, board } = await cardBoard(ctx, text(args.cardId, 64), 'editor')
      const properties = await ask(() => readBoardProperties(ctx.env.DB, card.boardId))
      const patch: { title?: string, values?: Record<string, string | null> } = {}
      if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim().slice(0, 500)
      if (typeof args.propertyId === 'string' && args.propertyId.trim()) {
        const propertyId = args.propertyId.trim().slice(0, 64)
        if (!properties.some((property) => property.id === propertyId)) throw new ToolError('That property is not on this board.')
        const raw = typeof args.value === 'string' ? args.value.slice(0, 2000) : ''
        patch.values = { [propertyId]: raw === '' ? null : raw }
      }
      if (patch.title === undefined && patch.values === undefined) throw new ToolError('Nothing to change: pass a title or a property with a value.')
      const updated = await ask(() => patchProjectCard(ctx.env.DB, card, patch, ctx.store.userId, ctx.now ?? Date.now()))
      return { updated: presentCard(updated, properties, board.role) }
    },
  },
  {
    name: 'project_schedule_card',
    description: 'Set a project card date property to a day or a range of days, written as yyyy-mm-dd.',
    permission: 'write',
    fields: {
      cardId: { type: 'string', description: 'Card id from project_list_cards.', maxLength: 64 },
      propertyId: { type: 'string', description: 'A date property on that board.', maxLength: 64 },
      from: { type: 'string', description: 'Start day, yyyy-mm-dd.', maxLength: 10 },
      to: { type: 'string', description: 'Last day of the range, yyyy-mm-dd.', maxLength: 10, optional: true },
    },
    async run(args, ctx) {
      const { card, board } = await cardBoard(ctx, text(args.cardId, 64), 'editor')
      const propertyId = text(args.propertyId, 64)
      const properties = await ask(() => readBoardProperties(ctx.env.DB, card.boardId))
      if (!properties.some((property) => property.id === propertyId && property.type === 'date')) throw new ToolError('That property is not a date property on this board.')
      const from = projectInputToStamp(text(args.from, 10))
      if (from === null) throw new ToolError('from must be a real calendar day written yyyy-mm-dd.')
      const to = typeof args.to === 'string' && args.to.trim() ? projectInputToStamp(args.to.trim().slice(0, 10)) : null
      if (typeof args.to === 'string' && args.to.trim() && to === null) throw new ToolError('to must be a real calendar day written yyyy-mm-dd.')
      const value = to === null || to === from ? { from } : { from, to: Math.max(from, to) }
      const updated = await ask(() => patchProjectCard(ctx.env.DB, card, { values: { [propertyId]: JSON.stringify(value) } }, ctx.store.userId, ctx.now ?? Date.now()))
      return { updated: presentCard(updated, properties, board.role) }
    },
  },
  {
    name: 'project_delete_card',
    description: 'Delete a project card. It is soft-deleted and can be restored from the board trash.',
    permission: 'destructive',
    fields: { cardId: { type: 'string', description: 'Card id from project_list_cards.', maxLength: 64 } },
    async prepare(args, ctx): Promise<PreparedTarget> {
      const { card } = await cardBoard(ctx, text(args.cardId, 64), 'editor')
      return { targetId: card.id, targetLabel: card.title || card.id }
    },
    async commit(targetId, ctx) {
      const { card } = await cardBoard(ctx, targetId, 'editor')
      await ask(() => softDeleteProjectCard(ctx.env.DB, card.id, ctx.store.userId, ctx.now ?? Date.now()))
      return { deleted: { id: card.id } }
    },
  },
]

/** The write half, so the open board knows which tool results should refresh it. */
export const PROJECT_WRITE_TOOLS: readonly string[] = PROJECT_BOARD_TOOLS
  .filter((tool) => tool.permission !== 'read')
  .map((tool) => tool.name)

export const PROJECT_TOOL_CARD_CAP = PROJECT_LIMITS.cardsPerBoard