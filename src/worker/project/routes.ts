import { Hono, type Context } from 'hono'
import { projectBoardToCsv } from '@shared/project/csv'
import {
  ProjectBoardCreateSchema,
  ProjectBoardFromTemplateSchema,
  ProjectBoardPatchSchema,
  ProjectBatchDeleteSchema,
  ProjectBatchSchema,
  ProjectCardCreateSchema,
  ProjectCardLinkSchema,
  ProjectCardPatchSchema,
  ProjectCategoryBoardHiddenSchema,
  ProjectCategoryBoardOrderSchema,
  ProjectCategoryCreateSchema,
  ProjectCategoryOrderSchema,
  ProjectCategoryPatchSchema,
  ProjectCommentCreateSchema,
  ProjectCommentPatchSchema,
  ProjectContentCreateSchema,
  ProjectContentMoveSchema,
  ProjectContentPatchSchema,
  ProjectMemberAddSchema,
  ProjectMemberPatchSchema,
  ProjectSharePutSchema,
  ProjectSubscriptionCreateSchema,
  ProjectTodoLinkSchema,
  ProjectViewCreateSchema,
  ProjectViewPatchSchema,
} from '@shared/project/validation'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { assertDeclaredBodySize, FORM_BODY_LIMITS, JSON_BODY_LIMITS, readBytesWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { originOf } from '../lib/notify'
import { broadcastProjectChange } from './realtime'
import { exportProjectBoardArchive, exportProjectAccountArchive, importProjectAccountArchive, importProjectBoardArchive } from './archive'
import { projectBody, projectUserId, requireBoard, requireCard, requireComment, requireContent, requireView } from './auth'
import { batchDeleteProjectBoard, batchPatchProjectBoard } from './batch'
import { readProjectBoardBundle } from './bundle'
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
import {
  createProjectBoard,
  getProjectBoardRow,
  patchProjectBoard,
  projectBoardMetadata,
  readBoardProperties,
  softDeleteProjectBoard,
  undeleteProjectBoard,
} from './boards'
import {
  addProjectMember,
  joinProjectBoard,
  leaveProjectBoard,
  listProjectMembers,
  removeProjectMember,
  setProjectMemberRole,
} from './members'
import { ProjectStore } from './store'
import { searchProject } from './search'
import { topProjectBoards } from './insights'
import { addCardLink, createCardFromTemplate, getCardTodoLink, linkCardTodo, listBoardLinks, listCardLinks, listProjectActivity, recordProjectActivity, removeCardLink, saveCardAsTemplate, syncCardCompletionToTodo, unlinkCardTodo } from './enhance'
import { notifyProjectComment } from './notify'
import { projectBoardToMarkdown } from '@shared/project/markdown'
import { deleteProjectAttachment, getProjectAttachment, listBoardAttachments, uploadProjectAttachment, PROJECT_UPLOAD_LIMIT } from './files'
import { deleteProjectShare, getProjectShare, putProjectShare, readPublicProjectShare } from './shares'
import { projectStatistics } from './statistics'
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

export const projectRoutes = new Hono<AppBindings>()

projectRoutes.use('*', requireAuth)

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
  const boardMatch = /^\/api\/project\/boards\/([^/]+)(?:\/|$)/.exec(path)
  if (boardMatch && boardMatch[1] !== 'import' && boardMatch[1] !== 'from-template') {
    boardId = boardMatch[1]
  } else {
    const child = /^\/api\/project\/(cards|views|contents|comments)\/([^/]+)/.exec(path)
    if (child) {
      const table = { cards: 'project_cards', views: 'project_views', contents: 'project_card_contents', comments: 'project_comments' }[child[1] as 'cards' | 'views' | 'contents' | 'comments']
      const row = await c.env.DB.prepare(`SELECT board_id FROM ${table} WHERE id = ?1`).bind(child[2]).first<{ board_id: string }>()
      boardId = row?.board_id
    }
  }
  if (!boardId) return
  const now = Date.now()
  const actor = c.get('userId') ?? c.get('user')?.id ?? ''
  const record = recordProjectActivity(c.env.DB, boardId, actor, method.toLowerCase(), path.split('/').pop() ?? '', `${method} ${path}`, now)
  record.catch((error: unknown) => console.warn('[inkstone] project activity record failed:', error instanceof Error ? error.message : error))
  const task = broadcastProjectChange(c.env, boardId, now, originOf(c), (t) => {
    // Best-effort: the test harness fetches without an ExecutionContext, whose getter throws.
    try { c.executionCtx?.waitUntil(t) } catch { /* no ExecutionContext in tests */ }
  })
  task.catch((error: unknown) => console.warn('[inkstone] project fan-out failed:', error instanceof Error ? error.message : error))
})

function store(c: Context<AppBindings>): ProjectStore {
  return new ProjectStore(c.env.DB, projectUserId(c))
}

projectRoutes.get('/boards', async (c) => {
  return c.json({ boards: await store(c).boards() })
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
  const bytes = await exportProjectAccountArchive(c.env.DB, projectUserId(c))
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="inkstone-project.zip"' },
  })
})

projectRoutes.get('/insights/top-boards', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 10) || 10, 1), 50)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)
  return c.json(await topProjectBoards(c.env.DB, projectUserId(c), limit, offset))
})

projectRoutes.get('/boards/:id/activity', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200)
  return c.json({ activity: await listProjectActivity(c.env.DB, board.id, limit) })
})

projectRoutes.get('/boards/:id/links', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ links: await listBoardLinks(c.env.DB, board.id) })
})

projectRoutes.get('/boards/:id/markdown', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role)
  const markdown = projectBoardToMarkdown(bundle, c.req.query('groupById'))
  return new Response(markdown, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${board.id}.md"` },
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
  const { card } = await requireCard(c, c.req.param('id'), 'editor')
  await unlinkCardTodo(c.env.DB, card.id)
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/files', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ files: await listBoardAttachments(c.env.DB, board.id, c.req.query('cardId')) })
})

projectRoutes.post('/boards/:id/files', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  assertDeclaredBodySize(c.req, PROJECT_UPLOAD_LIMIT + 1024 * 1024)
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('A file field is required')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const cardId = typeof form.get('cardId') === 'string' ? (form.get('cardId') as string) : null
  const attachment = await uploadProjectAttachment(c.env.DB, c.env.FILES, { boardId: board.id, cardId, userId, filename: file.name, mime: file.type || 'application/octet-stream', bytes }, Date.now())
  return c.json({ file: attachment }, 201)
})

projectRoutes.get('/files/:id', async (c) => {
  const attachment = await getProjectAttachment(c.env.DB, c.req.param('id'))
  if (!attachment) throw ApiError.notFound('File not found')
  await requireBoard(c, attachment.boardId, 'viewer')
  if (!c.env.FILES) throw ApiError.notFound('File not found')
  const object = await c.env.FILES.get(attachment.objectKey)
  if (!object) throw ApiError.notFound('File not found')
  return new Response(object.body, { headers: { 'Content-Type': attachment.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(attachment.filename)}"` } })
})

projectRoutes.delete('/files/:id', async (c) => {
  const attachment = await getProjectAttachment(c.env.DB, c.req.param('id'))
  if (!attachment) throw ApiError.notFound('File not found')
  await requireBoard(c, attachment.boardId, 'editor')
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
  return c.json({ board, properties: await readBoardProperties(c.env.DB, board.id), role })
})

projectRoutes.get('/boards/:id/bundle', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json(await readProjectBoardBundle(c.env.DB, board, role))
})

projectRoutes.post('/boards/:id/cards', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectCardCreateSchema)
  return c.json({ card: await createProjectCard(c.env.DB, board, userId, input, Date.now()) }, 201)
})

projectRoutes.post('/boards/:id/views', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectViewCreateSchema)
  return c.json({ view: await createProjectView(c.env.DB, board.id, userId, input, Date.now()) }, 201)
})

projectRoutes.patch('/boards/:id/batch', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectBatchSchema)
  await batchPatchProjectBoard(c.env.DB, board, input, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/batch-delete', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectBatchDeleteSchema)
  await batchDeleteProjectBoard(c.env.DB, board, input, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.patch('/boards/:id', async (c) => {
  const patch = await projectBody(c, ProjectBoardPatchSchema)
  const required = patch.type !== undefined || patch.minimumRole !== undefined ? 'admin' : 'editor'
  const { board } = await requireBoard(c, c.req.param('id'), required)
  return c.json(await patchProjectBoard(c.env.DB, board, patch, projectUserId(c), Date.now()))
})

projectRoutes.delete('/boards/:id', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  await softDeleteProjectBoard(c.env.DB, board.id, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/boards/:id/undelete', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin', { allowDeleted: true })
  await undeleteProjectBoard(c.env.DB, board.id, userId, Date.now())
  return c.json({ board: await getProjectBoardRow(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/duplicate', async (c) => {
  const { board, role, userId } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role)
  return c.json({ board: await duplicateProjectBoard(c.env.DB, bundle, userId, Date.now()) }, 201)
})

projectRoutes.post('/boards/:id/save-as-template', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  await saveBoardAsTemplate(c.env.DB, board.id, Date.now())
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  return c.json({ share: await getProjectShare(c.env.DB, board.id, userId) })
})

projectRoutes.put('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectSharePutSchema, JSON_BODY_LIMITS.small)
  return c.json({ share: await putProjectShare(c.env.DB, board, userId, input, Date.now()) })
})

projectRoutes.delete('/boards/:id/share', async (c) => {
  const { board, userId } = await requireBoard(c, c.req.param('id'), 'admin')
  await deleteProjectShare(c.env.DB, board.id, userId)
  return c.json({ ok: true })
})

projectRoutes.get('/boards/:id/metadata', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json(await projectBoardMetadata(c.env.DB, board.id))
})

projectRoutes.get('/boards/:id/archive', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bytes = await exportProjectBoardArchive(c.env.DB, board, role)
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${board.id}.boardarchive"`,
    },
  })
})

projectRoutes.get('/boards/:id/csv', async (c) => {
  const { board, role } = await requireBoard(c, c.req.param('id'), 'viewer')
  const bundle = await readProjectBoardBundle(c.env.DB, board, role)
  return new Response(projectBoardToCsv(bundle), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${board.id}.csv"`,
    },
  })
})

projectRoutes.post('/boards/import', async (c) => {
  const userId = projectUserId(c)
  assertDeclaredBodySize(c.req, FORM_BODY_LIMITS.import)
  const bytes = await readBytesWithinLimit(c.req.raw.body, FORM_BODY_LIMITS.import)
  return c.json(await importProjectBoardArchive(c.env.DB, userId, bytes, Date.now()), 201)
})

projectRoutes.post('/boards/import-account', async (c) => {
  const userId = projectUserId(c)
  assertDeclaredBodySize(c.req, FORM_BODY_LIMITS.import)
  const bytes = await readBytesWithinLimit(c.req.raw.body, FORM_BODY_LIMITS.import)
  return c.json({ boards: await importProjectAccountArchive(c.env.DB, userId, bytes, Date.now()) }, 201)
})

projectRoutes.get('/boards/:id/members', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ members: await listProjectMembers(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/members', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectMemberAddSchema, JSON_BODY_LIMITS.small)
  const member = await addProjectMember(c.env.DB, board, input.userId, input.role, Date.now())
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

projectRoutes.patch('/cards/:id', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  const patch = await projectBody(c, ProjectCardPatchSchema)
  const updated = await patchProjectCard(c.env.DB, card, patch, userId, Date.now())
  if (patch.values !== undefined) {
    const { results } = await c.env.DB.prepare('SELECT id, type, options FROM project_properties WHERE board_id = ?1').bind(card.boardId).all<{ id: string, type: string, options: string }>()
    const properties = results.map((p) => ({ id: p.id, type: p.type, options: JSON.parse(p.options) as { id: string, value: string }[] }))
    await syncCardCompletionToTodo(c.env.DB, updated, properties, Date.now())
  }
  return c.json({ card: updated })
})

projectRoutes.delete('/cards/:id', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  await softDeleteProjectCard(c.env.DB, card.id, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/cards/:id/undelete', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor', { allowDeleted: true })
  await undeleteProjectCard(c.env.DB, card.id, userId, Date.now())
  return c.json({ card: await getProjectCard(c.env.DB, card.id) })
})

projectRoutes.post('/cards/:id/duplicate', async (c) => {
  const { card, userId } = await requireCard(c, c.req.param('id'), 'editor')
  return c.json({ card: await duplicateProjectCard(c.env.DB, card, userId, Date.now()) }, 201)
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
  return c.json({ content: await createProjectContent(c.env.DB, card, userId, input, Date.now()) }, 201)
})

projectRoutes.get('/contents/:id', async (c) => {
  const { content } = await requireContent(c, c.req.param('id'), 'viewer')
  return c.json({ content })
})

projectRoutes.patch('/contents/:id', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  const patch = await projectBody(c, ProjectContentPatchSchema)
  return c.json({ content: await patchProjectContent(c.env.DB, content, patch, userId, Date.now()) })
})

projectRoutes.delete('/contents/:id', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  await softDeleteProjectContent(c.env.DB, content, userId, Date.now())
  return c.json({ ok: true })
})

projectRoutes.post('/contents/:id/undelete', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor', { allowDeleted: true })
  await undeleteProjectContent(c.env.DB, content, userId, Date.now())
  return c.json({ content: await getProjectContent(c.env.DB, content.id) })
})

projectRoutes.post('/contents/:id/move', async (c) => {
  const { content, userId } = await requireContent(c, c.req.param('id'), 'editor')
  const input = await projectBody(c, ProjectContentMoveSchema, JSON_BODY_LIMITS.small)
  return c.json({ content: await moveProjectContent(c.env.DB, content, input.targetId, input.where, userId, Date.now()) })
})

projectRoutes.get('/cards/:id/comments', async (c) => {
  const { card } = await requireCard(c, c.req.param('id'), 'viewer')
  return c.json({ comments: await listCardComments(c.env.DB, card.id) })
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

projectPublicRoutes.post('/:slug', async (c) => {
  let password: string | undefined
  const raw = await c.req.text()
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { password?: unknown }
      if (typeof parsed.password === 'string') password = parsed.password
    } catch {
      throw ApiError.badRequest('The request body is not valid JSON')
    }
  }
  return c.json(await readPublicProjectShare(c.env.DB, c.req.param('slug'), password, Date.now()))
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
  await reorderCategoryBoards(c.env.DB, projectUserId(c), c.req.param('id'), input.boardIds, Date.now())
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
  const edge = await setCategoryBoardHidden(c.env.DB, projectUserId(c), c.req.param('id'), c.req.param('boardId'), input.hidden, Date.now())
  return c.json({ categoryBoard: edge })
})