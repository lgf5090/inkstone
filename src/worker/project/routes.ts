import { Hono, type Context } from 'hono'
import { projectBoardToCsv } from '@shared/project/csv'
import { isProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectRole } from '@shared/project/model'
import {
  ProjectBoardCreateSchema,
  ProjectBoardFromTemplateSchema,
  ProjectBoardPatchSchema,
  ProjectBatchDeleteSchema,
  ProjectBatchSchema,
  ProjectCardCreateSchema,
  ProjectCardLinkSchema,
  ProjectCardMarksSchema,
  ProjectCardMoveSchema,
  ProjectCardPatchSchema,
  ProjectCardVersionRestoreSchema,
  ProjectCategoryBoardHiddenSchema,
  ProjectCategoryBoardOrderSchema,
  ProjectCategoryCreateSchema,
  ProjectCategoryOrderSchema,
  ProjectCategoryPatchSchema,
  ProjectCommentCreateSchema,
  ProjectCommentPatchSchema,
  ProjectDefaultViewPutSchema,
  ProjectApiTokenCreateSchema,
  ProjectSprintCreateSchema,
  ProjectSprintPatchSchema,
  ProjectWebhookCreateSchema,
  ProjectWebhookPatchSchema,
  ProjectContentCreateSchema,
  ProjectContentMoveSchema,
  ProjectContentPatchSchema,
  ProjectMemberAddSchema,
  ProjectMemberPatchSchema,
  ProjectAutomationCreateSchema,
  ProjectAutomationPatchSchema,
  ProjectSharePutSchema,
  ProjectPublicIntakeSchema,
  ProjectGuestOpenSchema,
  ProjectGuestPatchSchema,
  ProjectSubscriptionCreateSchema,
  ProjectTodoLinkSchema,
  ProjectViewCreateSchema,
  ProjectViewPatchSchema,
} from '@shared/project/validation'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { assertDeclaredBodySize, FORM_BODY_LIMITS, JSON_BODY_LIMITS, readBytesWithinLimit, readFormDataWithinLimit, readStreamTextWithinLimit, requestClientIp } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { consumeAttemptBudget } from '../lib/throttle'
import { originOf } from '../lib/notify'
import { broadcastProjectChange } from './realtime'
import { listProjectBoardPresence, touchProjectBoardPresence } from './presence'
import { exportProjectBoardArchive, exportProjectAccountArchive, importProjectAccountArchive, importProjectBoardArchive } from './archive'
import { projectBody, projectUserId, requireBoard, requireBoardOwner, requireCard, requireComment, requireContent, requireView } from './auth'
import { projectWebhookEvent } from '@shared/project/integrations'
import type { ProjectRealtimeEntity } from '@shared/types'
import type { ProjectActivityChange } from '@shared/project/model'
import {
  createProjectAuditChanges,
  diffProjectAuditSnapshot,
  recordProjectActivityChanges,
  type ProjectAuditEntity,
  type ProjectAuditSnapshot,
} from './audit'
import {
  claimProjectWriteReceipt,
  completeProjectWriteReceipt,
  discardProjectWriteReceipt,
  projectWriteFingerprint,
  PROJECT_WRITE_CLAIM_TTL_MS,
  readProjectWriteReceipt,
  type ProjectWriteReceipt,
} from './idempotency'
import {
  createProjectApiToken, listProjectApiTokens, projectTokenFromAuthorization,
  revokeProjectApiToken, verifyProjectApiToken,
} from './tokens'
import {
  createProjectWebhook, deleteProjectWebhook, deliverProjectWebhook,
  enqueueProjectWebhookEvents, listProjectWebhooks, patchProjectWebhook,
} from './webhooks'
import {
  createProjectSprint, deleteProjectSprint, getProjectSprint, listProjectSprints,
  patchProjectSprint, readSprintDetail, setCardSprint,
} from './sprints'
import { batchDeleteProjectBoard, batchPatchProjectBoard, projectBatchStatementCount } from './batch'
import { assertProjectBatchStatementLimit, PROJECT_D1_BATCH_STATEMENT_LIMIT } from './d1'
import { createProjectCardVersion, getProjectCardVersion, listProjectCardVersions, restoreProjectCardVersion } from './versions'
import { projectBoardCursor, readProjectBoardBundle, rowToComment, rowToContent, touchProjectBoard } from './bundle'
import {
  addBoardToCategory,
  createProjectCategory,
  deleteProjectCategory,
  listProjectCategories,
  listProjectCategoryBoards,
  patchProjectCategory,
  reorderCategoryBoards,
  reorderProjectCategories,
  setCategoryBoardHidden,
} from './categories'
import {
  createProjectCard,
  getProjectCard,
  getProjectCardRow,
  patchProjectCard,
  softDeleteProjectCard,
  undeleteProjectCard,
} from './cards'
import {
  createProjectComment,
  listCardComments,
  patchProjectComment,
  softDeleteProjectComment,
} from './comments'
import {
  createProjectContent,
  getProjectContent,
  moveProjectContent,
  patchProjectContent,
  softDeleteProjectContent,
  undeleteProjectContent,
} from './contents'
import { duplicateProjectBoard, duplicateProjectCard } from './duplicate'
import { moveProjectCard } from './move'
import {
  createProjectBoard,
  getProjectBoardRow,
  patchProjectBoard,
  projectBoardMetadata,
  readBoardProperties,
  readProjectPropertyRevision,
  softDeleteProjectBoard,
  undeleteProjectBoard,
} from './boards'
import {
  addProjectMember,
  joinProjectBoard,
  leaveProjectBoard,
  listProjectMembers,
  listProjectPeople,
  removeProjectMember,
  setProjectMemberRole,
} from './members'
import { ProjectStore } from './store'
import { searchProject } from './search'
import { topProjectBoards } from './insights'
import { addCardLink, applyCardValueEffects, createCardFromTemplate, getCardTodoLink, linkCardTodo, listBoardLinks, listCardLinks, listProjectActivity, recordProjectActivity, removeCardLink, saveCardAsTemplate, unlinkCardTodo } from './enhance'
import { notifyProjectComment } from './notify'
import { readProjectCardMarks, readProjectDefaultView, writeProjectCardMarks, writeProjectDefaultView } from './preferences'
import { toICal } from '../subscriptions/calendar'
import { parseProjectDateValue, projectStampToDay } from '@shared/project/date'
import { projectBoardToMarkdown } from '@shared/project/markdown'
import { deleteProjectAttachment, getProjectAttachment, listBoardAttachments, uploadProjectAttachment, PROJECT_UPLOAD_LIMIT, PROJECT_INLINE_MIMES } from './files'
import { deleteProjectShare, getProjectShare, putProjectShare, readPublicProjectShare, authorizePublicProjectShare } from './shares'
import { assertPublicIntakeValues } from './intake'
import { createProjectIntakeGrant, openProjectGuestCard, readProjectIntakeGrant, assertProjectGuestValues } from './guests'
import { projectStatistics } from './statistics'
import { listProjectMyTasks } from './my-tasks'
import { deleteTimeEntry, listCardTime, startCardTime, stopCardTime } from './time'
import { assertProjectValuesWritable } from './property-access'
import {
  assertProjectRelationValues,
  listBackReferences,
  listRelationOptions,
  projectRelationTargets,
  projectRelationBoardIds,
  rebuildBoardRelations,
  redactHiddenRelations,
} from './relations'
import {
  createProjectAutomation,
  deleteProjectAutomation,
  listProjectAutomations,
  patchProjectAutomation,
} from './automations'
import { createBoardFromTemplate, listProjectTemplates, saveBoardAsTemplate } from './templates'
import { listProjectSubscriptions, subscribeProject, unsubscribeProject } from './subscriptions'
import {
  createProjectView,
  duplicateProjectView,
  getProjectView,
  patchProjectView,
  softDeleteProjectView,
  undeleteProjectView,
} from './views'
import { projectCardForRole, projectPropertiesForRole } from './visibility'

export const projectRoutes = new Hono<AppBindings>()

const TOKEN_SESSION_ONLY_PATH = /(?:\/tokens(?:\/|$)|\/webhooks(?:\/|$)|\/members(?:\/|$)|\/share$|\/save-as-template$|\/automations(?:\/|$)|\/import(?:-account)?$)/
const TOKEN_ACCOUNT_EXPORT_PATH = /^\/api\/project\/export$/

function projectTokenValueMaps(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const maps: Record<string, unknown>[] = []
  if (record.values && typeof record.values === 'object' && !Array.isArray(record.values)) {
    maps.push(record.values as Record<string, unknown>)
  }
  if (Array.isArray(record.cards)) {
    for (const card of record.cards) maps.push(...projectTokenValueMaps(card))
  }
  if (record.patch) maps.push(...projectTokenValueMaps(record.patch))
  return maps
}

async function assertProjectTokenBodyScope(c: Context<AppBindings>, boardId: string): Promise<void> {
  if (!(c.req.header('Content-Type') ?? '').includes('application/json')) return
  let body: unknown
  try { body = await c.req.raw.clone().json() } catch { return }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const record = body as Record<string, unknown>
  if (typeof record.targetBoardId === 'string' && record.targetBoardId !== boardId) {
    throw ApiError.notFound('Board not found')
  }
  const maps = projectTokenValueMaps(body)
  if (!maps.length) return
  const properties = await readBoardProperties(c.env.DB, boardId)
  for (const property of properties) {
    if (property.type !== 'relation' || !property.config?.targetBoardId || property.config.targetBoardId === boardId) continue
    if (maps.some((values) => Object.hasOwn(values, property.id))) throw ApiError.notFound('Board not found')
  }
}

/**
 * Machine clients authenticate with a hashed, board-scoped token instead of a cookie. Setting
 * `userId` lets every existing route reuse `requireBoard`; the scope and board checks below are the
 * extra boundaries a token needs, and the management endpoints stay session-only so a token can
 * never mint another token or add an outbound target.
 */
projectRoutes.use('*', async (c, next) => {
  const secret = projectTokenFromAuthorization(c.req.header('Authorization'))
  if (!secret) return next()
  const auth = await verifyProjectApiToken(c.env.DB, secret, Date.now())
  if (!auth) throw ApiError.unauthenticated('Invalid API token')
  const path = c.req.path
  if (TOKEN_SESSION_ONLY_PATH.test(path) || TOKEN_ACCOUNT_EXPORT_PATH.test(path)
    || (c.req.method.toUpperCase() === 'DELETE' && /^\/api\/project\/boards\/[^/]+$/.test(path))) {
    throw ApiError.forbidden('This operation requires a browser session')
  }
  if (auth.scope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method.toUpperCase())) {
    throw ApiError.forbidden('This token is read-only')
  }
  if (auth.boardId) {
    let boardId = /^\/api\/project\/boards\/([^/]+)(?:\/|$)/.exec(path)?.[1]
    if (!boardId) {
      const child = /^\/api\/project\/(cards|views|contents|comments|files)\/([^/]+)/.exec(path)
      if (child) {
        const table = {
          cards: 'project_cards', views: 'project_views', contents: 'project_card_contents',
          comments: 'project_comments', files: 'project_attachments',
        }[child[1] as 'cards' | 'views' | 'contents' | 'comments' | 'files']
        const row = await c.env.DB.prepare(`SELECT board_id FROM ${table} WHERE id = ?1`).bind(child[2]).first<{ board_id: string }>()
        boardId = row?.board_id
      }
    }
    if (boardId !== auth.boardId) throw ApiError.notFound('Board not found')
    await assertProjectTokenBodyScope(c, auth.boardId)
  }
  c.set('userId', auth.userId)
  c.set('projectTokenId', auth.id)
  await next()
})

projectRoutes.use('*', requireAuth)

const WRITE_CHILD_TABLES = {
  cards: 'project_cards',
  views: 'project_views',
  contents: 'project_card_contents',
  comments: 'project_comments',
  files: 'project_attachments',
} as const

async function projectWriteBoardId(c: Context<AppBindings>): Promise<string> {
  const board = /^\/api\/project\/boards\/([^/]+)(?:\/|$)/.exec(c.req.path)?.[1]
  if (board && board !== 'import' && board !== 'from-template') return board
  const child = /^\/api\/project\/(cards|views|contents|comments|files)\/([^/]+)/.exec(c.req.path)
  if (!child) return ''
  const table = WRITE_CHILD_TABLES[child[1] as keyof typeof WRITE_CHILD_TABLES]
  const row = await c.env.DB.prepare(`SELECT board_id FROM ${table} WHERE id = ?1`).bind(child[2]).first<{ board_id: string }>()
  return row?.board_id ?? ''
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readProjectAuditSnapshot(c: Context<AppBindings>, entity: ProjectAuditEntity, id: string): Promise<ProjectAuditSnapshot> {
  if (entity === 'board') {
    const { board } = await requireBoard(c, id, 'viewer', { allowDeleted: true })
    return { entity, id, value: board as unknown as Record<string, unknown> }
  }
  if (entity === 'card') {
    const { card } = await requireCard(c, id, 'viewer', { allowDeleted: true })
    return { entity, id, value: card as unknown as Record<string, unknown> }
  }
  if (entity === 'comment') {
    const { comment } = await requireComment(c, id, 'viewer')
    return { entity, id, value: comment as unknown as Record<string, unknown> }
  }
  if (entity === 'content') {
    const { content } = await requireContent(c, id, 'viewer', { allowDeleted: true })
    return { entity, id, value: content as unknown as Record<string, unknown> }
  }
  const { view } = await requireView(c, id, 'viewer', { allowDeleted: true })
  return { entity, id, value: view as unknown as Record<string, unknown> }
}

function projectAuditTargets(path: string, method: string, input: unknown): Array<{ entity: ProjectAuditEntity, id: string }> {
  const targets: Array<{ entity: ProjectAuditEntity, id: string }> = []
  const add = (entity: ProjectAuditEntity, id: string): void => { targets.push({ entity, id }) }
  const board = /^\/api\/project\/boards\/([^/]+)$/.exec(path)?.[1]
  if (board && (method === 'PATCH' || method === 'DELETE')) add('board', board)
  if (/^\/api\/project\/boards\/[^/]+\/batch$/.test(path) && isAuditRecord(input)) {
    const operationCount = ['cards', 'contents', 'views'].reduce((count, key) => count + (Array.isArray(input[key]) ? input[key].length : 0), 0)
    if (operationCount <= PROJECT_LIMITS.batchOperations) {
      for (const [key, entity] of [['cards', 'card'], ['contents', 'content'], ['views', 'view']] as const) {
        const rows = input[key]
        if (!Array.isArray(rows)) continue
        for (const row of rows) if (isAuditRecord(row) && typeof row.id === 'string') add(entity, row.id)
      }
    }
  }
  if (/^\/api\/project\/boards\/[^/]+\/batch-delete$/.test(path) && isAuditRecord(input)) {
    const operationCount = ['cardIds', 'contentIds', 'viewIds'].reduce((count, key) => count + (Array.isArray(input[key]) ? input[key].length : 0), 0)
    if (operationCount <= PROJECT_LIMITS.batchOperations) {
      for (const [key, entity] of [['cardIds', 'card'], ['contentIds', 'content'], ['viewIds', 'view']] as const) {
        const ids = input[key]
        if (!Array.isArray(ids)) continue
        for (const id of ids) if (typeof id === 'string') add(entity, id)
      }
    }
  }
  if (method === 'PATCH' || method === 'DELETE') {
    const card = /^\/api\/project\/cards\/([^/]+)$/.exec(path)?.[1]
    const comment = /^\/api\/project\/comments\/([^/]+)$/.exec(path)?.[1]
    const content = /^\/api\/project\/contents\/([^/]+)$/.exec(path)?.[1]
    const view = /^\/api\/project\/views\/([^/]+)$/.exec(path)?.[1]
    if (card) add('card', card)
    if (comment) add('comment', comment)
    if (content) add('content', content)
    if (view) add('view', view)
  }
  const versionCard = /^\/api\/project\/cards\/([^/]+)\/versions\/[^/]+\/restore$/.exec(path)?.[1]
  if (versionCard && method === 'POST') add('card', versionCard)
  return targets
}

function projectAuditPatch(input: unknown, entity: ProjectAuditEntity, id: string): unknown {
  if (!isAuditRecord(input)) return input
  const key = entity === 'card' ? 'cards' : entity === 'content' ? 'contents' : entity === 'view' ? 'views' : ''
  if (!key) return input
  const rows = input[key]
  if (!Array.isArray(rows)) return input
  for (const row of rows) {
    if (isAuditRecord(row) && row.id === id && 'patch' in row) return row.patch
  }
  return undefined
}

async function projectVersionCardIds(c: Context<AppBindings>, input: unknown): Promise<string[]> {
  if (c.req.path.includes('/versions/')) return []
  const ids = new Set<string>()
  const add = (id: string | undefined): void => { if (id) ids.add(id) }
  const addContentCards = async (contentIds: readonly string[]): Promise<void> => {
    for (let offset = 0; offset < contentIds.length; offset += 90) {
      const chunk = contentIds.slice(offset, offset + 90)
      if (chunk.length === 0) continue
      const marks = chunk.map((_, index) => `?${index + 1}`).join(',')
      const { results } = await c.env.DB.prepare(`SELECT card_id FROM project_card_contents WHERE id IN (${marks})`).bind(...chunk).all<{ card_id: string }>()
      for (const row of results) add(row.card_id)
    }
  }
  const card = /^\/api\/project\/cards\/([^/]+)$/.exec(c.req.path)?.[1]
  if (card && (c.req.method === 'PATCH' || c.req.method === 'DELETE')) add(card)
  const nestedCreate = /^\/api\/project\/cards\/([^/]+)\/contents$/.exec(c.req.path)?.[1]
  if (nestedCreate && c.req.method === 'POST') add(nestedCreate)
  const content = /^\/api\/project\/contents\/([^/]+)$/.exec(c.req.path)?.[1]
  if (content && (c.req.method === 'PATCH' || c.req.method === 'DELETE')) await addContentCards([content])
  const movedContent = /^\/api\/project\/contents\/([^/]+)\/move$/.exec(c.req.path)?.[1]
  if (movedContent && c.req.method === 'POST') await addContentCards([movedContent])
  if (/^\/api\/project\/contents\/[^/]+\/undelete$/.test(c.req.path) && c.req.method === 'POST') {
    const id = /^\/api\/project\/contents\/([^/]+)\/undelete$/.exec(c.req.path)?.[1]
    if (id) await addContentCards([id])
  }
  if (isAuditRecord(input)) {
    if (Array.isArray(input.cards)) for (const row of input.cards) if (isAuditRecord(row) && typeof row.id === 'string') add(row.id)
    if (Array.isArray(input.contents)) {
      const contentIds = input.contents.filter((row): row is { id: string } => isAuditRecord(row) && typeof row.id === 'string').map((row) => row.id)
      await addContentCards(contentIds)
    }
    if (Array.isArray(input.cardIds)) for (const id of input.cardIds) if (typeof id === 'string') add(id)
    if (Array.isArray(input.contentIds)) await addContentCards(input.contentIds.filter((id): id is string => typeof id === 'string'))
  }
  return [...ids]
}

async function snapshotProjectRequestVersions(c: Context<AppBindings>, input: unknown): Promise<void> {
  for (const cardId of await projectVersionCardIds(c, input)) {
    await createProjectCardVersion(c.env.DB, cardId, projectUserId(c), Date.now()).catch((error: unknown) => {
      console.warn('[inkstone] project card version snapshot failed:', error instanceof Error ? error.message : error)
    })
  }
}

async function collectProjectAuditChanges(c: Context<AppBindings>, payload: Record<string, unknown> | null): Promise<ProjectActivityChange[]> {
  const before = c.get('projectAuditBefore') ?? []
  const input = c.get('projectAuditInput')
  const method = c.req.path.endsWith('/batch-delete') ? 'DELETE' : c.req.method.toUpperCase()
  const changes: ProjectActivityChange[] = []
  for (const snapshot of before) {
    const responseValue = payload?.[snapshot.entity]
    let next = isAuditRecord(responseValue) && responseValue.id === snapshot.id ? responseValue : null
    if (!next && method !== 'DELETE') next = (await readProjectAuditSnapshot(c, snapshot.entity, snapshot.id)).value
    const patch = c.req.path.includes('/versions/') && c.req.path.endsWith('/restore') ? next : projectAuditPatch(input, snapshot.entity, snapshot.id)
    changes.push(...diffProjectAuditSnapshot(snapshot, patch, next, method))
  }
  for (const entity of ['board', 'card', 'comment', 'content', 'view'] as const) {
    const value = payload?.[entity]
    if (!isAuditRecord(value) || typeof value.id !== 'string' || before.some((snapshot) => snapshot.entity === entity && snapshot.id === value.id)) continue
    changes.push(...createProjectAuditChanges(entity, value.id, input, value))
  }
  return changes.slice(0, 50)
}

function projectWriteOwnerRequired(c: Context<AppBindings>, body: string): boolean {
  const method = c.req.method.toUpperCase()
  if (method === 'DELETE' && /^\/api\/project\/boards\/[^/]+$/.test(c.req.path)) return true
  if (method === 'POST' && c.req.path.endsWith('/save-as-template')) return true
  if (c.req.path.endsWith('/share')) return true
  if (method !== 'PATCH' || !/^\/api\/project\/boards\/[^/]+$/.test(c.req.path)) return false
  try {
    const patch = JSON.parse(body) as Record<string, unknown>
    return ['type', 'minimumRole', 'archived', 'updatedCardProperties', 'deletedCardProperties']
      .some((key) => patch[key] !== undefined)
  } catch {
    return false
  }
}

function projectWriteRequiredRole(c: Context<AppBindings>, boardId: string): ProjectRole | '' {
  if (!boardId) return ''
  if (/\/(members|automations|webhooks)(\/|$)/.test(c.req.path)) return 'admin'
  if (/\/(card-marks|default-view|duplicate|join|leave)$/.test(c.req.path)) return 'viewer'
  return 'editor'
}

async function assertProjectReceiptAccess(c: Context<AppBindings>, receipt: ProjectWriteReceipt, body: string): Promise<void> {
  const userId = projectUserId(c)
  if (receipt.boardId) {
    const access = await requireBoard(c, receipt.boardId, receipt.requiredRole || 'viewer')
    if (receipt.ownerRequired && access.board.ownerId !== userId) throw ApiError.forbidden()
  }
  if (/^\/api\/project\/cards\/[^/]+\/move$/.test(c.req.path)) {
    try {
      const targetBoardId = (JSON.parse(body) as { targetBoardId?: unknown }).targetBoardId
      if (typeof targetBoardId === 'string') await requireBoard(c, targetBoardId, 'editor')
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw ApiError.badRequest('Invalid move request')
    }
  }
  try {
    const payload = JSON.parse(receipt.body) as { board?: { id?: unknown }, card?: { boardId?: unknown }, boards?: { id?: unknown }[] }
    const responseBoardIds = [
      payload.board?.id,
      payload.card?.boardId,
      ...(payload.boards ?? []).map((board) => board.id),
    ].filter((id): id is string => typeof id === 'string' && id !== receipt.boardId)
    for (const boardId of responseBoardIds) await requireBoard(c, boardId, 'viewer')
  } catch (error) {
    if (error instanceof ApiError) throw error
  }
}

/**
 * A queued offline write replays under the key it was minted with. A pending claim prevents concurrent
 * duplicate execution; a completed receipt is replayed only after its original resource role is checked
 * again, and only for the same method, path and request body.
 */
projectRoutes.use('*', async (c, next) => {
  const key = c.req.header('Idempotency-Key')
  const method = c.req.method.toUpperCase()
  if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key) || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next()
    return
  }
  const userId = projectUserId(c)
  const bodyBytes = await c.req.raw.clone().arrayBuffer()
  const body = new TextDecoder().decode(bodyBytes)
  const bodyHash = await projectWriteFingerprint(bodyBytes)
  const url = new URL(c.req.url)
  const path = `${url.pathname}${url.search}`
  const boardId = await projectWriteBoardId(c)
  const ownerRequired = projectWriteOwnerRequired(c, body)
  const requiredRole = projectWriteRequiredRole(c, boardId)

  let claimed = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    claimed = await claimProjectWriteReceipt(c.env.DB, userId, key, {
      method,
      path,
      bodyHash,
      boardId,
      requiredRole,
      ownerRequired,
    }, Date.now())
    if (claimed) break
    const stored = await readProjectWriteReceipt(c.env.DB, userId, key)
    if (stored?.state === 'legacy' || (stored?.state === 'pending' && Date.now() - stored.createdAt > PROJECT_WRITE_CLAIM_TTL_MS)) {
      await discardProjectWriteReceipt(c.env.DB, userId, key)
      continue
    }
    if (!stored || stored.state !== 'complete') throw ApiError.conflict('Idempotency key is already in progress')
    if (stored.method !== method || stored.path !== path || stored.bodyHash !== bodyHash) {
      throw ApiError.conflict('Idempotency key was already used for a different request')
    }
    await assertProjectReceiptAccess(c, stored, body)
    return new Response(stored.body, {
      status: stored.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!claimed) throw ApiError.conflict('Idempotency key is already in progress')

  try {
    await next()
    if (!c.res.ok || !(c.res.headers.get('content-type') ?? '').includes('application/json')) {
      await discardProjectWriteReceipt(c.env.DB, userId, key)
      return
    }
    const responseBody = await c.res.clone().text()
    if (responseBody.length > 64 * 1024) {
      await discardProjectWriteReceipt(c.env.DB, userId, key)
      return
    }
    await completeProjectWriteReceipt(c.env.DB, userId, key, c.res.status, responseBody, Date.now())
  } catch (error) {
    await discardProjectWriteReceipt(c.env.DB, userId, key)
    throw error
  }
})

projectRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || !(c.req.header('content-type') ?? '').includes('application/json')) {
    await next()
    return
  }
  const raw = await readStreamTextWithinLimit(c.req.raw.clone().body, JSON_BODY_LIMITS.project)
  let input: unknown
  try {
    input = raw ? JSON.parse(raw) as unknown : undefined
  } catch {
    input = undefined
  }
  c.set('projectAuditInput', input)
  let batchTooLarge = false
  if (/^\/api\/project\/boards\/[^/]+\/batch$/.test(c.req.path) && isAuditRecord(input)) {
    const cards = Array.isArray(input.cards) ? input.cards : []
    const statementCount = cards.reduce((count, row) => {
      if (!isAuditRecord(row) || !isAuditRecord(row.patch)) return count
      const values = isAuditRecord(row.patch.values) ? row.patch.values : {}
      return count + 1 + Object.keys(values).length
    }, 0) + (Array.isArray(input.contents) ? input.contents.length : 0) + (Array.isArray(input.views) ? input.views.length : 0)
    batchTooLarge = statementCount > PROJECT_D1_BATCH_STATEMENT_LIMIT
  }
  const oversized = raw === null || new TextEncoder().encode(raw).byteLength > JSON_BODY_LIMITS.project
  const targets = oversized || batchTooLarge ? [] : projectAuditTargets(c.req.path, method, input)
  const snapshots: ProjectAuditSnapshot[] = []
  for (const target of targets) snapshots.push(await readProjectAuditSnapshot(c, target.entity, target.id))
  c.set('projectAuditBefore', snapshots)
  await next()
})

/**
 * After any successful board-scoped write, tell every member's sync hub so open boards refetch. The
 * board id comes from the path for /boards/:id and from a row lookup for the child entities; routes
 * that own no board (categories, subscriptions, import) fall through untouched.
 */
projectRoutes.use('*', async (c, next) => {
  await next()
  const method = c.req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || !c.res.ok) return
  const path = c.req.path
  let boardId: string | undefined
  let targetId = ''
  let entity: ProjectRealtimeEntity = 'card'
  let cardId: string | undefined
  const boardMatch = /^\/api\/project\/boards\/([^/]+)(?:\/|$)/.exec(path)
  if (boardMatch && boardMatch[1] !== 'import' && boardMatch[1] !== 'from-template') {
    boardId = boardMatch[1]
    targetId = boardMatch[1]
    entity = 'board'
  } else {
    const child = /^\/api\/project\/(cards|views|contents|comments)\/([^/]+)/.exec(path)
    if (child) {
      const table = { cards: 'project_cards', views: 'project_views', contents: 'project_card_contents', comments: 'project_comments' }[child[1] as 'cards' | 'views' | 'contents' | 'comments']
      const row = await c.env.DB.prepare(`SELECT board_id FROM ${table} WHERE id = ?1`).bind(child[2]).first<{ board_id: string }>()
      boardId = row?.board_id
      targetId = child[2]
      if (child[1] === 'cards') cardId = child[2]
      if (child[1] === 'comments') entity = 'comment'
      else if (child[1] === 'contents') entity = 'content'
      else if (child[1] === 'views') entity = 'view'
    }
  }
  if (!boardId) return
  if (/\/presence$/.test(path)) return
  const cardMatch = /^\/api\/project\/cards\/([^/]+)/.exec(path)
  if (cardMatch) cardId = cardMatch[1]
  if (path.includes('/comments')) entity = 'comment'
  else if (path.includes('/contents')) entity = 'content'
  else if (path.includes('/views')) entity = 'view'
  else if (path.includes('/cards')) entity = 'card'
  // Per-reader preferences are not board content: bumping the cursor would make every other tab
  // refetch, and recording them would fill the activity feed with the act of choosing a tab.
  if (/\/(default-view|card-marks)$/.test(path)) return
  const now = Date.now()
  // Every board-scoped write advances the board's stamp, which is the cursor open tabs poll. Child
  // edits, deletes and moves would otherwise leave it behind and a second tab would never converge.
  await touchProjectBoard(c.env.DB, boardId, now).catch((error: unknown) => {
    console.warn('[inkstone] project board cursor bump failed:', error instanceof Error ? error.message : error)
  })
  const actor = c.get('userId') ?? c.get('user')?.id ?? ''
  let payload: Record<string, unknown> | null = null
  if ((c.res.headers.get('content-type') ?? '').includes('application/json')) {
    payload = await c.res.clone().json().catch((error: unknown) => {
      console.warn('[inkstone] project activity response read failed:', error instanceof Error ? error.message : error)
      return null
    }) as Record<string, unknown> | null
    for (const value of Object.values(payload ?? {})) {
      if (value && typeof value === 'object') {
        if (typeof (value as { id?: unknown }).id === 'string') targetId = (value as { id: string }).id
        if (typeof (value as { cardId?: unknown }).cardId === 'string') cardId = (value as { cardId: string }).cardId
      }
    }
  }
  const record = (async () => {
    const changes = await collectProjectAuditChanges(c, payload).catch((error: unknown) => {
      console.warn('[inkstone] project activity diff failed:', error instanceof Error ? error.message : error)
      return []
    })
    const activityId = await recordProjectActivity(c.env.DB, boardId, actor, method.toLowerCase(), targetId, `${method} ${path} board=${boardId} target=${targetId}`, now)
    await recordProjectActivityChanges(c.env.DB, activityId, boardId, actor, changes, now)
  })()
  record.catch((error: unknown) => console.warn('[inkstone] project activity record failed:', error instanceof Error ? error.message : error))
  try { c.executionCtx?.waitUntil(record) } catch { /* no ExecutionContext in tests */ }
  const task = broadcastProjectChange(c.env, boardId, now, originOf(c), {
    entity,
    ...(cardId ? { cardId } : {}),
    ...(entity === 'comment' ? { commentId: targetId } : {}),
  }, (t) => {
    // Best-effort: the test harness fetches without an ExecutionContext, whose getter throws.
    try { c.executionCtx?.waitUntil(t) } catch { /* no ExecutionContext in tests */ }
  })
  task.catch((error: unknown) => console.warn('[inkstone] project fan-out failed:', error instanceof Error ? error.message : error))
  if (!path.includes('/webhooks') && !path.includes('/tokens')) {
    const event = projectWebhookEvent(method, path)
    const delivery = enqueueProjectWebhookEvents(c.env.DB, boardId, event, {
      boardId, event, targetId, method, path, at: now,
    }, now).then((ids) => Promise.all(ids.map((id) => deliverProjectWebhook(c.env.DB, c.env, id, Date.now()))))
    delivery.catch((error: unknown) => {
      console.warn('[inkstone] project webhook dispatch failed:', error instanceof Error ? error.message : error)
    })
    try { c.executionCtx?.waitUntil(delivery) } catch { /* no ExecutionContext in tests */ }
  }
})

function projectExportFilename(id: string, extension: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension}`
}

function store(c: Context<AppBindings>): ProjectStore {
  return new ProjectStore(c.env.DB, projectUserId(c))
}

projectRoutes.get('/boards', async (c) => {
  return c.json({ boards: await store(c).boards() })
})

projectRoutes.get('/my-tasks', async (c) => {
  return c.json({ tasks: await listProjectMyTasks(c.env.DB, projectUserId(c)) })
})

projectRoutes.get('/statistics', async (c) => {
  return c.json(await projectStatistics(c.env.DB, projectUserId(c)))
})

projectRoutes.get('/search', async (c) => {
  const query = (c.req.query('q') ?? '').trim().slice(0, 200)
  if (!query) return c.json({ boards: [], cards: [] })
  return c.json(await searchProject(c.env.DB, projectUserId(c), query))
})

projectRoutes.get('/export', async (c) => {
  const userId = projectUserId(c)
  await consumeAttemptBudget(c.env.DB, [{ key: `project-export:${userId}`, maxAttempts: 10, windowMs: 60 * 60 * 1000 }])
  const archive = await exportProjectAccountArchive(c.env.DB, { r2: c.env.FILES, kv: c.env.FILES_KV }, userId)
  return new Response(archive.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="inkstone-project.zip"',
      'Content-Length': String(archive.size),
      'Cache-Control': 'private, no-store',
    },
  })
})

projectRoutes.get('/insights/top-boards', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 10) || 10, 1), 50)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)
  return c.json(await topProjectBoards(c.env.DB, projectUserId(c), limit, offset))
})

/** The restore list: soft-deleted boards this account owns, which the live list deliberately hides. */
projectRoutes.get('/trash', async (c) => {
  return c.json({ boards: await store(c).deletedBoards() })
})

/** Archived boards this account owns: hidden from the live list, kept whole for restore. */
projectRoutes.get('/archived', async (c) => {
  return c.json({ boards: await store(c).archivedBoards() })
})

/** Soft-deleted cards on one board, for the same restore panel. */
projectRoutes.get('/boards/:id/trash', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin', { allowDeleted: true })
  const { results } = await c.env.DB
    .prepare('SELECT id, title, delete_at FROM project_cards WHERE board_id = ?1 AND delete_at != 0 ORDER BY delete_at DESC LIMIT 200')
    .bind(board.id).all<{ id: string, title: string, delete_at: number }>()
  return c.json({ cards: results.map((row) => ({ id: row.id, title: row.title, deleteAt: row.delete_at })) })
})

projectRoutes.get('/boards/:id/activity', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200)
  return c.json({ activity: await listProjectActivity(c.env.DB, board.id, limit) })
})

projectRoutes.post('/boards/:id/presence', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  const now = Date.now()
  await touchProjectBoardPresence(c.env.DB, board.id, userId, now)
  return c.json({ users: await listProjectBoardPresence(c.env.DB, board.id, now) }, 202)
})

projectRoutes.get('/boards/:id/links', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ links: await listBoardLinks(c.env.DB, board.id) })
})

projectRoutes.get('/boards/:id/markdown', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c))
  const markdown = projectBoardToMarkdown(bundle, c.req.query('groupById'))
  return new Response(markdown, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${projectExportFilename(board.id, 'md')}"` },
  })
})

projectRoutes.get('/cards/:id/links', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ links: await listCardLinks(c.env.DB, card.id) })
})

projectRoutes.post('/cards/:id/links', async (c) => {
  const { card, board } = await requireCard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectCardLinkSchema, JSON_BODY_LIMITS.small)
  await addCardLink(c.env.DB, board.id, card.id, input.toCardId, input.kind, Date.now())
  return c.json({ ok: true }, 201)
})

projectRoutes.get('/cards/:id/time', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ entries: await listCardTime(c.env.DB, card.id) })
})

projectRoutes.post('/cards/:id/time/start', async (c) => {
  const { card, board } = await requireCard(c, c.req.param('id'), 'editor')
  const entry = await startCardTime(c.env.DB, { boardId: board.id, cardId: card.id, userId: projectUserId(c) }, Date.now())
  return c.json({ entry }, 201)
})

projectRoutes.post('/cards/:id/time/stop', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'editor')
  return c.json({ entry: await stopCardTime(c.env.DB, card.id, projectUserId(c), Date.now()) })
})

projectRoutes.delete('/cards/:id/time/:entryId', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'editor')
  await deleteTimeEntry(c.env.DB, card.id, c.req.param('entryId'))
  return c.json({ ok: true })
})

projectRoutes.delete('/cards/:id/links/:toId', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'editor')
  const kind = (c.req.query('kind') ?? 'blocks') as 'blocks' | 'parent'
  await removeCardLink(c.env.DB, card.id, c.req.param('toId'), kind)
  return c.json({ ok: true })
})

projectRoutes.get('/cards/:id/todo-link', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ todoId: await getCardTodoLink(c.env.DB, card.id) })
})

projectRoutes.post('/cards/:id/todo-link', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectTodoLinkSchema, JSON_BODY_LIMITS.small)
  await linkCardTodo(c.env.DB, card.id, input.todoId, userId, Date.now())
  return c.json({ ok: true }, 201)
})

projectRoutes.delete('/cards/:id/todo-link', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  await unlinkCardTodo(c.env.DB, card.id, userId)
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/files', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ files: await listBoardAttachments(c.env.DB, board.id, c.req.query('cardId')) })
})

projectRoutes.post('/boards/:id/files', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  await consumeAttemptBudget(c.env.DB, [{ key: `project-upload:${userId}`, maxAttempts: 100, windowMs: 60 * 60 * 1000 }])
  const form = await readFormDataWithinLimit(c.req, PROJECT_UPLOAD_LIMIT + 1024 * 1024)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('A file field is required')
  if (file.size > PROJECT_UPLOAD_LIMIT) throw ApiError.tooLarge('File too large')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const cardId = typeof form.get('cardId') === 'string' ? (form.get('cardId') as string) : null
  if (cardId) {
    const cardRow = await getProjectCardRow(c.env.DB, cardId)
    if (!cardRow || cardRow.board_id !== board.id || cardRow.delete_at !== 0) {
      throw ApiError.badRequest('Card does not belong to this board')
    }
  }
  const attachment = await uploadProjectAttachment(c.env.DB, c.env.FILES, { boardId: board.id, cardId, userId, filename: file.name, mime: file.type || 'application/octet-stream', bytes }, Date.now())
  return c.json({ file: attachment }, 201)
})

projectRoutes.get('/files/:id', async (c) => {
  const attachment = await getProjectAttachment(c.env.DB, c.req.param('id'))
  if (!attachment) throw ApiError.notFound('File not found')
  const access = await requireBoard(c, attachment.boardId, 'viewer')
  if (attachment.cardId) {
    const card = await getProjectCardRow(c.env.DB, attachment.cardId)
    if ((!card || card.delete_at !== 0) && access.role !== 'admin') throw ApiError.notFound('File not found')
  }
  if (!c.env.FILES) throw ApiError.notFound('File not found')
  const object = await c.env.FILES.get(attachment.objectKey)
  if (!object) throw ApiError.notFound('File not found')
  // The stored mime is client-controlled; only render a safe allowlist inline. Anything else
  // (html/svg/…) downloads as an opaque blob so it can never execute in this origin (stored XSS).
  const safeInline = PROJECT_INLINE_MIMES.has(attachment.mime)
  const cleanFilename = attachment.filename.replace(/[\r\n"\\;]/g, '_')
  return new Response(object.body, {
    headers: {
      'Content-Type': safeInline ? attachment.mime : 'application/octet-stream',
      'Content-Disposition': `${safeInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(cleanFilename)}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

projectRoutes.delete('/files/:id', async (c) => {
  const attachment = await getProjectAttachment(c.env.DB, c.req.param('id'))
  if (!attachment) throw ApiError.notFound('File not found')
  const access = await requireBoard(c, attachment.boardId, 'editor')
  if (attachment.cardId) {
    const card = await getProjectCardRow(c.env.DB, attachment.cardId)
    if ((!card || card.delete_at !== 0) && access.role !== 'admin') throw ApiError.notFound('File not found')
  }
  await deleteProjectAttachment(c.env.DB, c.env.FILES, attachment)
  return c.json({ ok: true })
})

projectRoutes.get('/templates', async (c) => {
  return c.json({ templates: await listProjectTemplates(c.env.DB, projectUserId(c), c.req.query('locale') ?? '') })
})

projectRoutes.post('/boards/from-template', async (c) => {
  const userId = projectUserId(c)
  const input = await projectBody(c, ProjectBoardFromTemplateSchema, JSON_BODY_LIMITS.small)
  return c.json({ board: await createBoardFromTemplate(c.env.DB, userId, input.templateId, Date.now(), input.locale ?? '') }, 201)
})

projectRoutes.post('/boards', async (c) => {
  const input = await projectBody(c, ProjectBoardCreateSchema)
  const board = await createProjectBoard(c.env.DB, projectUserId(c), input, Date.now())
  return c.json({ board }, 201)
})

projectRoutes.get('/boards/:id', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ board, properties: projectPropertiesForRole(await readBoardProperties(c.env.DB, board.id), role), role, propertyRevision: await readProjectPropertyRevision(c.env.DB, board.id) })
})

/** The cheap staleness question: a poller asks this before paying for the whole bundle. */
projectRoutes.get('/boards/:id/card-marks', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ marks: await readProjectCardMarks(c.env.DB, userId, board.id) })
})

projectRoutes.put('/boards/:id/card-marks', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  const marks = await projectBody(c, ProjectCardMarksSchema, JSON_BODY_LIMITS.small)
  await writeProjectCardMarks(c.env.DB, userId, board.id, marks, Date.now())
  return c.json({ marks })
})

/** A reader's landing tab follows the account, so another device opens the same view. */
projectRoutes.get('/boards/:id/default-view', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ viewId: await readProjectDefaultView(c.env.DB, userId, board.id) })
})

projectRoutes.put('/boards/:id/default-view', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  const input = await projectBody(c, ProjectDefaultViewPutSchema, JSON_BODY_LIMITS.small)
  if (input.viewId !== null) {
    const row = await c.env.DB.prepare('SELECT board_id FROM project_views WHERE id = ?1 AND delete_at = 0')
      .bind(input.viewId).first<{ board_id: string }>()
    if (!row || row.board_id !== board.id) throw ApiError.badRequest('View does not belong to this board')
  }
  await writeProjectDefaultView(c.env.DB, userId, board.id, input.viewId, Date.now())
  return c.json({ viewId: input.viewId })
})

projectRoutes.get('/boards/:id/cursor', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ cursor: await projectBoardCursor(c.env.DB, board) })
})

projectRoutes.get('/boards/:id/bundle', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c), { limit: PROJECT_LIMITS.bundleCards })
  await redactHiddenRelations(c.env.DB, bundle, projectUserId(c))
  return c.json(bundle)
})

projectRoutes.get('/boards/:id/cards/:cardId', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c), { cardId: c.req.param('cardId') })
  await redactHiddenRelations(c.env.DB, bundle, projectUserId(c))
  const card = bundle.cards[0]
  if (!card) throw ApiError.notFound('Card not found')
  return c.json({ card })
})

projectRoutes.get('/boards/:id/cards', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const requestedLimit = Number(c.req.query('limit'))
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c), {
    cursor: c.req.query('cursor'),
    limit: Number.isFinite(requestedLimit) ? requestedLimit : PROJECT_LIMITS.bundleCards,
  })
  await redactHiddenRelations(c.env.DB, bundle, projectUserId(c))
  return c.json(bundle)
})

projectRoutes.post('/boards/:id/cards', async (c) => {
  const { board, userId, role } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectCardCreateSchema)
  const properties = await readBoardProperties(c.env.DB, board.id)
  await assertProjectValuesWritable(c.env.DB, board.id, role, input.values)
  await assertProjectRelationValues(c.env.DB, properties, input.values, userId)
  return c.json({ card: projectCardForRole(await createProjectCard(c.env.DB, board, userId, input, Date.now(), projectRelationTargets(properties)), properties, role) }, 201)
})

projectRoutes.post('/boards/:id/views', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectViewCreateSchema)
  return c.json({ view: await createProjectView(c.env.DB, board.id, userId, input, Date.now()) }, 201)
})

projectRoutes.patch('/boards/:id/batch', async (c) => {
  const { board, userId, role } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectBatchSchema)
  assertProjectBatchStatementLimit(projectBatchStatementCount(input))
  await snapshotProjectRequestVersions(c, input)
  await batchPatchProjectBoard(c.env.DB, board, input, userId, Date.now(), role, c.env)
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/batch-delete', async (c) => {
  const { board, userId, role } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectBatchDeleteSchema)
  await snapshotProjectRequestVersions(c, input)
  await batchDeleteProjectBoard(c.env.DB, board, input, userId, Date.now(), role)
  return c.json({ ok: true })
})

projectRoutes.patch('/boards/:id', async (c) => {
  const patch = await projectBody(c, ProjectBoardPatchSchema)
  const ownerOnly = patch.type !== undefined || patch.minimumRole !== undefined || patch.archived !== undefined
    || patch.updatedCardProperties !== undefined || patch.deletedCardProperties !== undefined
  const { board } = ownerOnly
    ? await requireBoardOwner(c, c.req.param('id'))
    : await requireBoard(c, c.req.param('id'), 'editor')
  return c.json(await patchProjectBoard(c.env.DB, board, patch, projectUserId(c), Date.now()))
})

projectRoutes.delete('/boards/:id', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'))
  await softDeleteProjectBoard(c.env.DB, board.id, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/undelete', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'), { allowDeleted: true })
  await undeleteProjectBoard(c.env.DB, board.id, userId, Date.now())
  return c.json({ board: await getProjectBoardRow(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/duplicate', async (c) => {
  const { board, role, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  await consumeAttemptBudget(c.env.DB, [{ key: `project-duplicate:${userId}`, maxAttempts: 30, windowMs: 60 * 60 * 1000 }])
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c))
  return c.json({ board: await duplicateProjectBoard(c.env.DB, bundle, userId, Date.now()) }, 201)
})

projectRoutes.post('/boards/:id/save-as-template', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'))
  const template = await saveBoardAsTemplate(c.env.DB, board.id, userId, Date.now())
  return c.json({ template }, 201)
})

projectRoutes.get('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'))
  return c.json({ share: await getProjectShare(c.env.DB, board.id, userId) })
})

projectRoutes.put('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'))
  const input = await projectBody(c, ProjectSharePutSchema, JSON_BODY_LIMITS.small)
  return c.json({ share: await putProjectShare(c.env.DB, board, userId, input, Date.now()) })
})

projectRoutes.delete('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoardOwner(c, c.req.param('id'))
  await deleteProjectShare(c.env.DB, board.id, userId)
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/automations', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ automations: await listProjectAutomations(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/automations', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectAutomationCreateSchema, JSON_BODY_LIMITS.small)
  return c.json({ automation: await createProjectAutomation(c.env.DB, board.id, userId, input, Date.now()) }, 201)
})

projectRoutes.patch('/boards/:id/automations/:ruleId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectAutomationPatchSchema, JSON_BODY_LIMITS.small)
  const automation = await patchProjectAutomation(c.env.DB, board.id, c.req.param('ruleId'), input, Date.now())
  if (!automation) throw ApiError.notFound('Automation not found')
  return c.json({ automation })
})

projectRoutes.delete('/boards/:id/automations/:ruleId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  await deleteProjectAutomation(c.env.DB, board.id, c.req.param('ruleId'))
  return c.json({ ok: true })
})

/** Account-level machine credentials; the plaintext secret is returned once, at creation only. */
projectRoutes.get('/tokens', async (c) => {
  return c.json({ tokens: await listProjectApiTokens(c.env.DB, projectUserId(c)) })
})

projectRoutes.post('/tokens', async (c) => {
  const userId = projectUserId(c)
  await consumeAttemptBudget(c.env.DB, [{ key: `project-token-create:${userId}`, maxAttempts: 20, windowMs: 60 * 60 * 1000 }])
  const input = await projectBody(c, ProjectApiTokenCreateSchema, JSON_BODY_LIMITS.small)
  if (input.boardId) await requireBoard(c, input.boardId, 'admin')
  return c.json(await createProjectApiToken(c.env.DB, userId, input, Date.now()), 201)
})

projectRoutes.delete('/tokens/:id', async (c) => {
  const revoked = await revokeProjectApiToken(c.env.DB, projectUserId(c), c.req.param('id'), Date.now())
  if (!revoked) throw ApiError.notFound('Token not found')
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/webhooks', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  return c.json({ webhooks: await listProjectWebhooks(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/webhooks', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  await consumeAttemptBudget(c.env.DB, [{ key: `project-webhook-create:${userId}`, maxAttempts: 20, windowMs: 60 * 60 * 1000 }])
  const input = await projectBody(c, ProjectWebhookCreateSchema, JSON_BODY_LIMITS.small)
  return c.json(await createProjectWebhook(c.env.DB, c.env, board.id, userId, input, Date.now()), 201)
})

projectRoutes.patch('/boards/:id/webhooks/:hookId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectWebhookPatchSchema, JSON_BODY_LIMITS.small)
  const webhook = await patchProjectWebhook(c.env.DB, board.id, c.req.param('hookId'), input, Date.now())
  if (!webhook) throw ApiError.notFound('Webhook not found')
  return c.json({ webhook })
})

projectRoutes.delete('/boards/:id/webhooks/:hookId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  await deleteProjectWebhook(c.env.DB, board.id, c.req.param('hookId'))
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/sprints', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ sprints: await listProjectSprints(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/sprints', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectSprintCreateSchema, JSON_BODY_LIMITS.small)
  return c.json({ sprint: await createProjectSprint(c.env.DB, board.id, userId, input, Date.now()) }, 201)
})

projectRoutes.get('/boards/:id/sprints/:sprintId', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const detail = await readSprintDetail(c.env.DB, board, role, c.req.param('sprintId'), Date.now(), projectUserId(c))
  if (!detail) throw ApiError.notFound('Sprint not found')
  return c.json(detail)
})

projectRoutes.patch('/boards/:id/sprints/:sprintId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectSprintPatchSchema, JSON_BODY_LIMITS.small)
  const sprint = await patchProjectSprint(c.env.DB, board.id, c.req.param('sprintId'), input, Date.now())
  if (!sprint) throw ApiError.notFound('Sprint not found')
  return c.json({ sprint })
})

projectRoutes.delete('/boards/:id/sprints/:sprintId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'editor')
  await deleteProjectSprint(c.env.DB, board.id, c.req.param('sprintId'), Date.now())
  return c.json({ ok: true })
})

projectRoutes.put('/boards/:id/sprints/:sprintId/cards/:cardId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'editor')
  const sprintId = c.req.param('sprintId')
  const sprint = await getProjectSprint(c.env.DB, board.id, sprintId)
  if (!sprint) throw ApiError.notFound('Sprint not found')
  const cardId = c.req.param('cardId')
  const card = await getProjectCardRow(c.env.DB, cardId)
  if (!card || card.board_id !== board.id || card.delete_at !== 0) throw ApiError.notFound('Card not found')
  await setCardSprint(c.env.DB, board.id, cardId, sprintId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.delete('/boards/:id/sprints/:sprintId/cards/:cardId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'editor')
  const sprintId = c.req.param('sprintId')
  const sprint = await getProjectSprint(c.env.DB, board.id, sprintId)
  if (!sprint) throw ApiError.notFound('Sprint not found')
  const cardId = c.req.param('cardId')
  const edge = await c.env.DB.prepare(
    'SELECT 1 FROM project_sprint_cards WHERE board_id = ?1 AND sprint_id = ?2 AND card_id = ?3',
  ).bind(board.id, sprintId, cardId).first()
  if (!edge) throw ApiError.notFound('Card is not in this sprint')
  await setCardSprint(c.env.DB, board.id, cardId, null, Date.now())
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/properties', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ properties: projectPropertiesForRole(await readBoardProperties(c.env.DB, board.id), role) })
})

projectRoutes.get('/boards/:id/metadata', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json(await projectBoardMetadata(c.env.DB, board.id))
})

projectRoutes.get('/boards/:id/archive', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const archive = await exportProjectBoardArchive(c.env.DB, { r2: c.env.FILES, kv: c.env.FILES_KV }, board, role, projectUserId(c))
  return new Response(archive.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${projectExportFilename(board.id, 'boardarchive')}"`,
      'Content-Length': String(archive.size),
      'Cache-Control': 'private, no-store',
    },
  })
})

projectRoutes.get('/boards/:id/csv', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role, projectUserId(c))
  return new Response(projectBoardToCsv(bundle), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${projectExportFilename(board.id, 'csv')}"`,
    },
  })
})

projectRoutes.post('/boards/import', async (c) => {
  const userId = projectUserId(c)
  await consumeAttemptBudget(c.env.DB, [{ key: `project-import:${userId}`, maxAttempts: 20, windowMs: 60 * 60 * 1000 }])
  assertDeclaredBodySize(c.req, FORM_BODY_LIMITS.import)
  const bytes = await readBytesWithinLimit(c.req.raw.body, FORM_BODY_LIMITS.import)
  return c.json(await importProjectBoardArchive(c.env.DB, { r2: c.env.FILES, kv: c.env.FILES_KV }, userId, bytes, Date.now()), 201)
})

projectRoutes.post('/boards/import-account', async (c) => {
  const userId = projectUserId(c)
  await consumeAttemptBudget(c.env.DB, [{ key: `project-import-account:${userId}`, maxAttempts: 10, windowMs: 60 * 60 * 1000 }])
  assertDeclaredBodySize(c.req, FORM_BODY_LIMITS.import)
  const bytes = await readBytesWithinLimit(c.req.raw.body, FORM_BODY_LIMITS.import)
  return c.json({ boards: await importProjectAccountArchive(c.env.DB, { r2: c.env.FILES, kv: c.env.FILES_KV }, userId, bytes, Date.now()) }, 201)
})

projectRoutes.get('/boards/:id/members', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  const members = await listProjectMembers(c.env.DB, board.id)
  const people = await listProjectPeople(c.env.DB, members.map((member) => member.userId))
  return c.json({ members, people })
})

projectRoutes.post('/boards/:id/members', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  await consumeAttemptBudget(c.env.DB, [{ key: `project-member-add:${userId}`, maxAttempts: 20, windowMs: 60 * 60 * 1000 }])
  const input = await projectBody(c, ProjectMemberAddSchema, JSON_BODY_LIMITS.small)
  const member = await addProjectMember(c.env.DB, board, input.username, input.role, Date.now())
  return c.json({ member }, 201)
})

projectRoutes.patch('/boards/:id/members/:userId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectMemberPatchSchema, JSON_BODY_LIMITS.small)
  const member = await setProjectMemberRole(c.env.DB, board, c.req.param('userId'), input.role, Date.now())
  return c.json({ member })
})

projectRoutes.delete('/boards/:id/members/:userId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  await removeProjectMember(c.env.DB, board, c.req.param('userId'))
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/join', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json(await joinProjectBoard(c.env.DB, board, userId, Date.now()))
})

projectRoutes.post('/boards/:id/leave', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  await leaveProjectBoard(c.env.DB, board, userId)
  return c.json({ ok: true })
})

projectRoutes.get('/cards/:id', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ card })
})

projectRoutes.get('/cards/:id/detail', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  const [contents, comments] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM project_card_contents WHERE card_id = ?1 AND board_id = ?2 AND delete_at = 0 ORDER BY position, id').bind(card.id, card.boardId).all<Parameters<typeof rowToContent>[0]>(),
    c.env.DB.prepare('SELECT * FROM project_comments WHERE card_id = ?1 AND board_id = ?2 AND delete_at = 0 ORDER BY create_at, id').bind(card.id, card.boardId).all<Parameters<typeof rowToComment>[0]>(),
  ])
  return c.json({ contents: contents.results.map(rowToContent), comments: comments.results.map(rowToComment) })
})

projectRoutes.patch('/cards/:id', async (c) => {
  const { rawCard, board, userId, role } = await requireCard(c, c.req.param('id'), 'editor')
  const patch = await projectBody(c, ProjectCardPatchSchema)
  const properties = await readBoardProperties(c.env.DB, rawCard.boardId)
  await assertProjectValuesWritable(c.env.DB, rawCard.boardId, role, patch.values)
  await assertProjectRelationValues(c.env.DB, properties, patch.values, userId)
  await snapshotProjectRequestVersions(c, patch)
  const now = Date.now()
  const updated = await patchProjectCard(c.env.DB, rawCard, patch, userId, now, projectRelationTargets(properties))
  if (patch.values !== undefined) {
    const fresh = await applyCardValueEffects(c.env.DB, c.env, board, rawCard, updated, properties, userId, now)
    return c.json({ card: projectCardForRole(fresh, properties, role) })
  }
  return c.json({ card: projectCardForRole(updated, properties, role) })
})

projectRoutes.delete('/cards/:id', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  await snapshotProjectRequestVersions(c, undefined)
  await softDeleteProjectCard(c.env.DB, card.id, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/cards/:id/undelete', async (c) => {
  const { card, board, userId, role } = await requireCard(c, c.req.param('id'), 'editor', { allowDeleted: true })
  const now = Date.now()
  await undeleteProjectCard(c.env.DB, card.id, userId, now)
  const relatedBoardIds = new Set([board.id, ...await projectRelationBoardIds(c.env.DB, card.id)])
  for (const relatedBoardId of relatedBoardIds) {
    await rebuildBoardRelations(c.env.DB, relatedBoardId, await readBoardProperties(c.env.DB, relatedBoardId), now)
  }
  const restored = await getProjectCard(c.env.DB, card.id)
  const properties = await readBoardProperties(c.env.DB, board.id)
  return c.json({ card: projectCardForRole(restored!, properties, role) })
})

projectRoutes.get('/boards/:id/relation-cards', async (c) => {
  const boardId = c.req.param('id')
  if (!isProjectId(boardId)) throw ApiError.badRequest('invalid board id')
  return c.json({ cards: await listRelationOptions(c.env.DB, boardId, projectUserId(c), 200) })
})

projectRoutes.get('/cards/:id/relations', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ references: await listBackReferences(c.env.DB, card.id, projectUserId(c)) })
})

projectRoutes.post('/cards/:id/duplicate', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  return c.json({ card: await duplicateProjectCard(c.env.DB, card, userId, Date.now()) }, 201)
})

projectRoutes.post('/cards/:id/move', async (c) => {
  const { card, userId, role } = await requireCard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectCardMoveSchema, JSON_BODY_LIMITS.small)
  await requireBoard(c, input.targetBoardId, 'editor')
  const moved = await moveProjectCard(c.env.DB, card, input.targetBoardId, userId, Date.now(), role)
  const properties = await readBoardProperties(c.env.DB, moved.boardId)
  return c.json({ card: projectCardForRole(moved, properties, role) })
})

projectRoutes.post('/cards/:id/save-as-template', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'editor')
  await saveCardAsTemplate(c.env.DB, card.id, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/cards/from-template', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectBoardFromTemplateSchema, JSON_BODY_LIMITS.small)
  return c.json({ card: await createCardFromTemplate(c.env.DB, board, userId, input.templateId, Date.now()) }, 201)
})

projectRoutes.get('/views/:id', async (c) => {
  const { view } = await requireView(c, c.req.param('id'), 'viewer')
  return c.json({ view })
})

projectRoutes.patch('/views/:id', async (c) => {
  const { view, userId } = await requireView(c, c.req.param('id'), 'editor')
  const patch = await projectBody(c, ProjectViewPatchSchema)
  return c.json({ view: await patchProjectView(c.env.DB, view, patch, userId, Date.now()) })
})

projectRoutes.delete('/views/:id', async (c) => {
  const { view, userId } = await requireView(c, c.req.param('id'), 'editor')
  await softDeleteProjectView(c.env.DB, view.id, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/views/:id/undelete', async (c) => {
  const { view, userId } = await requireView(c, c.req.param('id'), 'editor', { allowDeleted: true })
  await undeleteProjectView(c.env.DB, view.id, userId, Date.now())
  return c.json({ view: await getProjectView(c.env.DB, view.id) })
})

projectRoutes.post('/views/:id/duplicate', async (c) => {
  const { view, userId } = await requireView(c, c.req.param('id'), 'editor')
  return c.json({ view: await duplicateProjectView(c.env.DB, view, userId, Date.now()) }, 201)
})

projectRoutes.post('/cards/:id/contents', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectContentCreateSchema)
  await snapshotProjectRequestVersions(c, input)
  return c.json({ content: await createProjectContent(c.env.DB, card, userId, input, Date.now()) }, 201)
})

projectRoutes.get('/contents/:id', async (c) => {
  const { content } = await requireContent(c, c.req.param('id'), 'viewer')
  return c.json({ content })
})

projectRoutes.patch('/contents/:id', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  const patch = await projectBody(c, ProjectContentPatchSchema)
  await snapshotProjectRequestVersions(c, patch)
  return c.json({ content: await patchProjectContent(c.env.DB, content, patch, userId, Date.now()) })
})

projectRoutes.delete('/contents/:id', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  await snapshotProjectRequestVersions(c, undefined)
  await softDeleteProjectContent(c.env.DB, content, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/contents/:id/undelete', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor', { allowDeleted: true })
  await snapshotProjectRequestVersions(c, undefined)
  await undeleteProjectContent(c.env.DB, content, userId, Date.now())
  return c.json({ content: await getProjectContent(c.env.DB, content.id) })
})

projectRoutes.post('/contents/:id/move', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectContentMoveSchema, JSON_BODY_LIMITS.small)
  await snapshotProjectRequestVersions(c, input)
  return c.json({ content: await moveProjectContent(c.env.DB, content, input.targetId, input.where, userId, Date.now()) })
})

projectRoutes.get('/cards/:id/versions', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ versions: await listProjectCardVersions(c.env.DB, card.id) })
})

projectRoutes.get('/cards/:id/versions/:versionId', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  const version = await getProjectCardVersion(c.env.DB, card.id, c.req.param('versionId'))
  if (!version) throw ApiError.notFound('Version not found')
  return c.json({ version })
})

projectRoutes.post('/cards/:id/versions/:versionId/restore', async (c) => {
  const { card, board, userId, role } = await requireCard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectCardVersionRestoreSchema)
  if (input.expectedUpdateAt !== card.updateAt) throw ApiError.conflict('Card changed on another device')
  const version = await getProjectCardVersion(c.env.DB, card.id, c.req.param('versionId'))
  if (!version) throw ApiError.notFound('Version not found')
  await createProjectCardVersion(c.env.DB, card.id, userId, Date.now())
  const restored = await restoreProjectCardVersion(c.env.DB, c.env, board, card, version, userId, Math.max(Date.now(), card.updateAt + 1))
  const properties = await readBoardProperties(c.env.DB, card.boardId)
  return c.json({ card: projectCardForRole(restored, properties, role) })
})

projectRoutes.get('/cards/:id/comments', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ comments: await listCardComments(c.env.DB, card.id, card.boardId) })
})

projectRoutes.post('/cards/:id/comments', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'commenter')
  const input = await projectBody(c, ProjectCommentCreateSchema)
  const comment = await createProjectComment(c.env.DB, card, userId, input, Date.now())
  await notifyProjectComment(c.env.DB, c.env, { boardId: card.boardId, cardId: card.id, cardTitle: card.title, body: input.body, authorId: userId }).catch(() => { /* best-effort: a refused mention notice must not refuse the comment */ })
  return c.json({ comment }, 201)
})

projectRoutes.patch('/comments/:id', async (c) => {
  const { comment, userId } = await requireComment(c, c.req.param('id'), 'commenter')
  if (comment.authorId !== userId) throw ApiError.forbidden()
  const input = await projectBody(c, ProjectCommentPatchSchema)
  return c.json({ comment: await patchProjectComment(c.env.DB, comment, input.body, Date.now()) })
})

projectRoutes.delete('/comments/:id', async (c) => {
  const { comment, userId } = await requireComment(c, c.req.param('id'), 'commenter')
  if (comment.authorId !== userId) throw ApiError.forbidden()
  await softDeleteProjectComment(c.env.DB, comment, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/subscriptions', async (c) => {
  const userId = projectUserId(c)
  const input = await projectBody(c, ProjectSubscriptionCreateSchema, JSON_BODY_LIMITS.small)
  if (input.blockType === 'board') await requireBoard(c, input.blockId, 'viewer')
  else await requireCard(c, input.blockId, 'viewer')
  return c.json({ subscription: await subscribeProject(c.env.DB, userId, input.blockType, input.blockId, Date.now()) }, 201)
})

projectRoutes.get('/subscriptions', async (c) => {
  return c.json({ subscriptions: await listProjectSubscriptions(c.env.DB, projectUserId(c)) })
})

projectRoutes.delete('/subscriptions/:blockId', async (c) => {
  await unsubscribeProject(c.env.DB, projectUserId(c), c.req.param('blockId'), Date.now())
  return c.json({ ok: true })
})

/** Public read-only share reader: no session, the slug (plus optional password) is the capability. */
export const projectPublicRoutes = new Hono<AppBindings>()

projectPublicRoutes.get('/:slug/calendar.ics', async (c) => {
  const slug = c.req.param('slug').replace(/\.ics$/i, '')
  const bundle = await readPublicProjectShare(c.env.DB, slug, undefined, Date.now(), requestClientIp(c))
  const dateProperty = bundle.properties.find((property) => property.type === 'date')
  const events = dateProperty
    ? bundle.cards.flatMap((card) => {
      const parsed = parseProjectDateValue(card.values[dateProperty.id] ?? '')
      if (parsed?.from === undefined) return []
      const date = projectStampToDay(parsed.from, parsed.includeTime === true, parsed.timeZone)
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      return [{ uid: `${card.id}@inkstone.project`, day, title: card.title || c.req.param('slug'), detail: bundle.board.title }]
    })
    : []
  return new Response(toICal(events, { name: bundle.board.title || 'Inkstone board', stamp: Date.now() }), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  })
})

projectPublicRoutes.post('/:slug', async (c) => {
  assertDeclaredBodySize(c.req, JSON_BODY_LIMITS.small)
  const raw = await readStreamTextWithinLimit(c.req.raw.body, JSON_BODY_LIMITS.small)
  if (raw === null) throw ApiError.tooLarge('The request body is too large')
  let password: string | undefined
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { password?: unknown }
      if (typeof parsed.password === 'string') password = parsed.password
    } catch {
      throw ApiError.badRequest('The request body is not valid JSON')
    }
  }
  return c.json(await readPublicProjectShare(c.env.DB, c.req.param('slug'), password, Date.now(), requestClientIp(c)))
})

projectPublicRoutes.post('/:slug/intake', async (c) => {
  const key = c.req.header('Idempotency-Key')
  if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw ApiError.badRequest('A valid Idempotency-Key is required')
  assertDeclaredBodySize(c.req, JSON_BODY_LIMITS.project)
  const bytes = await readBytesWithinLimit(c.req.raw.body, JSON_BODY_LIMITS.project)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw ApiError.badRequest('The request body is not valid JSON')
  }
  const parsed = ProjectPublicIntakeSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed')
  }
  const input = parsed.data
  const slug = c.req.param('slug')
  const now = Date.now()
  const context = await authorizePublicProjectShare(c.env.DB, slug, input.password, now, requestClientIp(c), 'intake')
  const properties = await readBoardProperties(c.env.DB, context.board.id)
  await assertPublicIntakeValues(c.env.DB, context.board.id, properties, context.intake, input.values)
  const receiptUser = `public:intake:${slug}`
  const bodyHash = await projectWriteFingerprint(bytes.buffer as ArrayBuffer)
  const claim = {
    method: 'POST',
    path: `/api/project/public/${slug}/intake`,
    bodyHash,
    boardId: context.board.id,
    requiredRole: '' as const,
    ownerRequired: false,
  }
  let claimed = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    claimed = await claimProjectWriteReceipt(c.env.DB, receiptUser, key, claim, now)
    if (claimed) break
    const stored = await readProjectWriteReceipt(c.env.DB, receiptUser, key)
    if (stored?.state === 'legacy' || (stored?.state === 'pending' && now - stored.createdAt > PROJECT_WRITE_CLAIM_TTL_MS)) {
      await discardProjectWriteReceipt(c.env.DB, receiptUser, key)
      continue
    }
    if (!stored || stored.state !== 'complete') throw ApiError.conflict('Intake submission is already in progress')
    if (stored.method !== claim.method || stored.path !== claim.path || stored.bodyHash !== bodyHash || stored.boardId !== context.board.id) {
      throw ApiError.conflict('Idempotency key was already used for a different request')
    }
    return c.json(JSON.parse(stored.body) as { ok: true, cardId: string, editable: boolean }, 201)
  }
  if (!claimed) throw ApiError.conflict('Intake submission is already in progress')
  try {
    const cardInput = ProjectCardCreateSchema.parse({ title: input.title, values: input.values })
    const card = await createProjectCard(c.env.DB, context.board, 'public:intake', cardInput, now)
    let editToken: string | undefined
    if (context.intake.editable) {
      try {
        editToken = await createProjectIntakeGrant(c.env.DB, {
          cardId: card.id,
          boardId: card.boardId,
          shareSlug: slug,
          fieldIds: context.intake.propertyIds,
          expiresAt: context.row.expires_at,
          now,
        })
      } catch (error) {
        console.warn('[inkstone] public intake edit grant failed:', error instanceof Error ? error.message : error)
      }
    }
    const response = { ok: true as const, cardId: card.id, editable: editToken !== undefined }
    await completeProjectWriteReceipt(c.env.DB, receiptUser, key, 201, JSON.stringify(response), now)
    await touchProjectBoard(c.env.DB, context.board.id, now).catch((error: unknown) => {
      console.warn('[inkstone] public intake board cursor bump failed:', error instanceof Error ? error.message : error)
    })
    const schedule = (task: Promise<unknown>): void => {
      try { c.executionCtx?.waitUntil(task) } catch { /* no ExecutionContext in tests */ }
    }
    schedule(broadcastProjectChange(c.env, context.board.id, now, null, { entity: 'card', cardId: card.id }))
    const activity = (async () => {
      const activityId = await recordProjectActivity(c.env.DB, context.board.id, 'public:intake', 'post', card.id, 'Public intake created a card', now)
      await recordProjectActivityChanges(c.env.DB, activityId, context.board.id, 'public:intake', [{
        entity: 'card', entityId: card.id, field: 'created', newValue: true,
      }], now)
    })()
    schedule(activity)
    const webhook = enqueueProjectWebhookEvents(c.env.DB, context.board.id, 'card.created', {
      boardId: context.board.id, event: 'card.created', targetId: card.id, method: 'POST', path: c.req.path, at: now,
    }, now).then((ids) => Promise.all(ids.map((id) => deliverProjectWebhook(c.env.DB, c.env, id, now))))
    schedule(webhook)
    return c.json({ ...response, ...(editToken ? { editToken } : {}) }, 201)
  } catch (error) {
    await discardProjectWriteReceipt(c.env.DB, receiptUser, key)
    throw error
  }
})

projectPublicRoutes.post('/:slug/guest/open', async (c) => {
  const input = await projectBody(c, ProjectGuestOpenSchema)
  const now = Date.now()
  const slug = c.req.param('slug')
  const context = await authorizePublicProjectShare(c.env.DB, slug, input.password, now, requestClientIp(c), 'guest')
  const grant = await readProjectIntakeGrant(c.env.DB, slug, input.cardId, input.token, now)
  if (!grant || grant.card.boardId !== context.board.id) throw ApiError.notFound('Edit link not found')
  return c.json(await openProjectGuestCard(c.env.DB, context.board.id, grant.card, grant.fieldIds))
})

projectPublicRoutes.post('/:slug/guest', async (c) => {
  const key = c.req.header('Idempotency-Key')
  if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw ApiError.badRequest('A valid Idempotency-Key is required')
  const input = await projectBody(c, ProjectGuestPatchSchema)
  const now = Date.now()
  const slug = c.req.param('slug')
  const context = await authorizePublicProjectShare(c.env.DB, slug, input.password, now, requestClientIp(c), 'guest')
  const grant = await readProjectIntakeGrant(c.env.DB, slug, input.cardId, input.token, now)
  if (!grant || grant.card.boardId !== context.board.id) throw ApiError.notFound('Edit link not found')
  const receiptUser = `public:guest:${slug}:${input.cardId}`
  const bodyHash = await projectWriteFingerprint(new TextEncoder().encode(JSON.stringify(input)).buffer as ArrayBuffer)
  const claim = {
    method: 'POST',
    path: `/api/project/public/${slug}/guest`,
    bodyHash,
    boardId: context.board.id,
    requiredRole: '' as const,
    ownerRequired: false,
  }
  let claimed = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    claimed = await claimProjectWriteReceipt(c.env.DB, receiptUser, key, claim, now)
    if (claimed) break
    const stored = await readProjectWriteReceipt(c.env.DB, receiptUser, key)
    if (stored?.state === 'legacy' || (stored?.state === 'pending' && now - stored.createdAt > PROJECT_WRITE_CLAIM_TTL_MS)) {
      await discardProjectWriteReceipt(c.env.DB, receiptUser, key)
      continue
    }
    if (!stored || stored.state !== 'complete') throw ApiError.conflict('Guest edit is already in progress')
    if (stored.method !== claim.method || stored.path !== claim.path || stored.bodyHash !== bodyHash || stored.boardId !== context.board.id) {
      throw ApiError.conflict('Idempotency key was already used for a different request')
    }
    return c.json(JSON.parse(stored.body) as { ok: true, cardId: string, updateAt: number }, 200)
  }
  if (!claimed) throw ApiError.conflict('Guest edit is already in progress')
  try {
    if (input.expectedUpdateAt !== grant.card.updateAt) throw ApiError.conflict('Card changed on another device')
    const properties = await readBoardProperties(c.env.DB, context.board.id)
    await assertProjectGuestValues(c.env.DB, context.board.id, properties, grant.fieldIds, input.values ?? {})
    await createProjectCardVersion(c.env.DB, grant.card.id, 'public:guest', now).catch((error: unknown) => {
      console.warn('[inkstone] public guest version snapshot failed:', error instanceof Error ? error.message : error)
    })
    const patch = ProjectCardPatchSchema.parse({ title: input.title, values: input.values })
    const updated = await patchProjectCard(c.env.DB, grant.card, patch, 'public:guest', now, projectRelationTargets(properties))
    await applyCardValueEffects(c.env.DB, c.env, context.board, grant.card, updated, properties, 'public:guest', now).catch((error: unknown) => {
      console.warn('[inkstone] public guest value effects failed:', error instanceof Error ? error.message : error)
    })
    const response = { ok: true as const, cardId: updated.id, updateAt: updated.updateAt }
    await completeProjectWriteReceipt(c.env.DB, receiptUser, key, 200, JSON.stringify(response), now)
    await touchProjectBoard(c.env.DB, context.board.id, now).catch((error: unknown) => {
      console.warn('[inkstone] public guest board cursor bump failed:', error instanceof Error ? error.message : error)
    })
    const changes: ProjectActivityChange[] = []
    if (input.title !== undefined && input.title !== grant.card.title) {
      changes.push({ entity: 'card', entityId: updated.id, field: 'title', oldValue: grant.card.title, newValue: input.title })
    }
    for (const [propertyId, value] of Object.entries(input.values ?? {})) {
      if (value === grant.card.values[propertyId]) continue
      changes.push({ entity: 'card', entityId: updated.id, field: `values.${propertyId}`, oldValue: '[redacted]', newValue: '[redacted]' })
    }
    const schedule = (task: Promise<unknown>): void => {
      try { c.executionCtx?.waitUntil(task) } catch { /* no ExecutionContext in tests */ }
    }
    schedule(broadcastProjectChange(c.env, context.board.id, now, null, { entity: 'card', cardId: updated.id }))
    const activity = (async () => {
      const activityId = await recordProjectActivity(c.env.DB, context.board.id, 'public:guest', 'patch', updated.id, 'Public guest edited a submission', now)
      await recordProjectActivityChanges(c.env.DB, activityId, context.board.id, 'public:guest', changes, now)
    })()
    schedule(activity)
    const webhook = enqueueProjectWebhookEvents(c.env.DB, context.board.id, 'card.updated', {
      boardId: context.board.id, event: 'card.updated', targetId: updated.id, method: 'POST', path: c.req.path, at: now,
    }, now).then((ids) => Promise.all(ids.map((id) => deliverProjectWebhook(c.env.DB, c.env, id, now))))
    schedule(webhook)
    return c.json(response)
  } catch (error) {
    await discardProjectWriteReceipt(c.env.DB, receiptUser, key)
    throw error
  }
})

projectRoutes.post('/categories', async (c) => {
  const input = await projectBody(c, ProjectCategoryCreateSchema, JSON_BODY_LIMITS.small)
  return c.json({ category: await createProjectCategory(c.env.DB, projectUserId(c), input, Date.now()) }, 201)
})

projectRoutes.get('/categories', async (c) => {
  const userId = projectUserId(c)
  const [categories, categoryBoards] = await Promise.all([
    listProjectCategories(c.env.DB, userId),
    listProjectCategoryBoards(c.env.DB, userId),
  ])
  return c.json({ categories, categoryBoards })
})

projectRoutes.put('/categories/order', async (c) => {
  const input = await projectBody(c, ProjectCategoryOrderSchema, JSON_BODY_LIMITS.small)
  await reorderProjectCategories(c.env.DB, projectUserId(c), input.categoryIds, Date.now())
  return c.json({ ok: true })
})

projectRoutes.patch('/categories/:id', async (c) => {
  const input = await projectBody(c, ProjectCategoryPatchSchema, JSON_BODY_LIMITS.small)
  return c.json({ category: await patchProjectCategory(c.env.DB, projectUserId(c), c.req.param('id'), input, Date.now()) })
})

projectRoutes.delete('/categories/:id', async (c) => {
  await deleteProjectCategory(c.env.DB, projectUserId(c), c.req.param('id'), Date.now())
  return c.json({ ok: true })
})

projectRoutes.put('/categories/:id/boards/order', async (c) => {
  const input = await projectBody(c, ProjectCategoryBoardOrderSchema, JSON_BODY_LIMITS.small)
  const userId = projectUserId(c)
  const visible = new Set((await new ProjectStore(c.env.DB, userId).boards()).map((board) => board.id))
  if (input.boardIds.some((boardId) => !visible.has(boardId))) throw ApiError.notFound('Board not found')
  await reorderCategoryBoards(c.env.DB, userId, c.req.param('id'), input.boardIds, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/categories/:id/boards/:boardId', async (c) => {
  const userId = projectUserId(c)
  await requireBoard(c, c.req.param('boardId'), 'viewer')
  const edge = await addBoardToCategory(c.env.DB, userId, c.req.param('id'), c.req.param('boardId'), Date.now())
  return c.json({ categoryBoard: edge }, 201)
})

projectRoutes.put('/categories/:id/boards/:boardId/hidden', async (c) => {
  const input = await projectBody(c, ProjectCategoryBoardHiddenSchema, JSON_BODY_LIMITS.small)
  await requireBoard(c, c.req.param('boardId'), 'viewer')
  const edge = await setCategoryBoardHidden(c.env.DB, projectUserId(c), c.req.param('id'), c.req.param('boardId'), input.hidden, Date.now())
  return c.json({ categoryBoard: edge })
})