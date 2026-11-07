import { Hono, type Context } from 'hono'
import {
  ProjectBoardCreateSchema,
  ProjectBoardPatchSchema,
  ProjectCardCreateSchema,
  ProjectCardPatchSchema,
  ProjectCommentCreateSchema,
  ProjectCommentPatchSchema,
  ProjectContentCreateSchema,
  ProjectContentMoveSchema,
  ProjectContentPatchSchema,
  ProjectMemberAddSchema,
  ProjectMemberPatchSchema,
  ProjectViewCreateSchema,
  ProjectViewPatchSchema,
} from '@shared/project/validation'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { projectBody, projectUserId, requireBoard, requireCard, requireComment, requireContent, requireView } from './auth'
import { readProjectBoardBundle } from './bundle'
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

function store(c: Context<AppBindings>): ProjectStore {
  return new ProjectStore(c.env.DB, projectUserId(c))
}

projectRoutes.get('/boards', async (c) => {
  return c.json({ boards: await store(c).boards() })
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

projectRoutes.get('/boards/:id/metadata', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json(await projectBoardMetadata(c.env.DB, board.id))
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
  return c.json({ card: await patchProjectCard(c.env.DB, card, patch, userId, Date.now()) })
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
  return c.json({ comment: await createProjectComment(c.env.DB, card, userId, input, Date.now()) }, 201)
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