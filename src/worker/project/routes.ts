import { Hono, type Context } from 'hono'
import { ProjectMemberAddSchema, ProjectMemberPatchSchema } from '@shared/project/validation'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { projectBody, projectUserId, requireBoard } from './auth'
import {
  addProjectMember,
  joinProjectBoard,
  leaveProjectBoard,
  listProjectMembers,
  removeProjectMember,
  setProjectMemberRole,
} from './members'
import { ProjectStore } from './store'

export const projectRoutes = new Hono<AppBindings>()

projectRoutes.use('*', requireAuth)

function store(c: Context<AppBindings>): ProjectStore {
  return new ProjectStore(c.env.DB, projectUserId(c))
}

projectRoutes.get('/boards', async (c) => {
  return c.json({ boards: await store(c).boards() })
})

projectRoutes.get('/boards/:id/members', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'viewer')
  return c.json({ members: await listProjectMembers(c.env.DB, board.id) })
})

projectRoutes.post('/boards/:id/members', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectMemberAddSchema)
  const member = await addProjectMember(c.env.DB, board, input.userId, input.role, Date.now())
  return c.json({ member }, 201)
})

projectRoutes.patch('/boards/:id/members/:userId', async (c) => {
  const { board } = await requireBoard(c, c.req.param('id'), 'admin')
  const input = await projectBody(c, ProjectMemberPatchSchema)
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