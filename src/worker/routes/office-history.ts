/**
 * The history protocol Univer's official history panel speaks.
 *
 * The panel asks three questions — which versions exist, who wrote them, and what changed between two
 * revisions — and expects Univer's wire shape (`error.code`, `historyIds`, `entities.datas`), not our
 * own. This file answers them from `office_file_version`, the same rows our version dialog reads, so
 * the official panel and our dialog can never disagree about what a version is.
 *
 * What it does not answer: the per-cell diff. That needs the protocol changesets the collaboration
 * engine records while editing, and this deployment stores whole snapshots instead. The `cs` route
 * therefore returns an empty range, which the panel renders as a version without a change list rather
 * than as an error.
 */
import { Hono, type Context } from 'hono'
import { OFFICE_LIMITS } from '@shared/office/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { requireAuth } from '../middleware/auth'
import { OfficeStore } from '../office/store'

type Ctx = Context<AppBindings>

export const officeHistoryRoutes = new Hono<AppBindings>()

officeHistoryRoutes.use('*', requireAuth)

/** `ErrorCode.OK` in `@univerjs/protocol`; anything else makes the client throw on the response. */
const HISTORY_OK = 1

const DEFAULT_PAGE = 20

interface HistoryWireVersion {
  unitId: string
  userId: string
  userIds: string[]
  startRevision: number
  endRevision: number
  createTime: number
  command: string[]
}

interface HistoryWireUser {
  name: string
  avatar: string
  anonymous: boolean
}

function store(c: Ctx): OfficeStore {
  return new OfficeStore(c.env.DB, c.get('userId'))
}

function unitIdParam(c: Ctx): string {
  const unitId = c.req.param('unitId') ?? ''
  if (!isValidId(unitId)) throw ApiError.notFound('File not found')
  return unitId
}

/**
 * The file is the unit: every product opens its snapshot under the file id, so a unit the account
 * cannot see is a 404 here for the same reason it is one on `/api/office/files/:id`.
 */
async function liveFile(c: Ctx): Promise<{ id: string; rev: number }> {
  const file = await store(c).liveFileRow(unitIdParam(c))
  if (!file) throw ApiError.notFound('File not found')
  return { id: file.id, rev: file.rev }
}

function pageSize(c: Ctx): number {
  const raw = Number(c.req.query('length') ?? '')
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE
  return Math.min(Math.floor(raw), OFFICE_LIMITS.versionsPerFile)
}

/** `lastLabel` carries the oldest revision the previous page returned; paging walks backwards from it. */
function lastRevision(c: Ctx): number | null {
  const raw = c.req.query('lastLabel') ?? ''
  if (!/^\d{1,15}$/.test(raw)) return null
  const value = Number(raw)
  return value > 0 ? value : null
}

officeHistoryRoutes.get('/:unitId/list', async (c) => {
  const file = await liveFile(c)
  const versions = await store(c).listVersions(file.id)
  const cursor = lastRevision(c)
  const older = cursor === null ? versions : versions.filter((version) => version.rev < cursor)
  const limit = pageSize(c)
  const page = older.slice(0, limit)
  const user = c.get('user')

  const datas: Record<string, HistoryWireVersion> = {}
  for (const version of page) {
    datas[`rev-${version.rev}`] = {
      unitId: file.id,
      userId: user.id,
      userIds: [user.id],
      startRevision: version.rev,
      endRevision: version.rev,
      createTime: version.created_at,
      command: [],
    }
  }

  const users: Record<string, HistoryWireUser> = {
    [user.id]: { name: user.name || user.login, avatar: user.avatarUrl ?? '', anonymous: false },
  }

  return c.json({
    error: { code: HISTORY_OK },
    hasMore: older.length > page.length,
    lastLabel: page.length > 0 ? String(page[page.length - 1]?.rev ?? '') : '',
    historyIds: page.map((version) => `rev-${version.rev}`),
    entities: { datas, users },
  })
})

officeHistoryRoutes.get('/:unitId/creators', async (c) => {
  await liveFile(c)
  const user = c.get('user')
  return c.json({
    error: { code: HISTORY_OK },
    creators: [
      {
        userId: user.id,
        name: user.name || user.login,
        avatar: user.avatarUrl ?? '',
        origins: [1],
      },
    ],
  })
})

/**
 * An empty range, deliberately: the panel asks what changed between two revisions and this deployment
 * recorded versions, not changesets. Returning `changesets: []` keeps the version list usable and
 * leaves the change list empty; it must never fabricate mutations the file never had.
 */
officeHistoryRoutes.get('/:unitId/cs', async (c) => {
  await liveFile(c)
  const base = Number(c.req.query('startRevision') ?? '0')
  const target = Number(c.req.query('endRevision') ?? '0')
  return c.json({
    error: { code: HISTORY_OK },
    changesets: [],
    users: {},
    comparison: {
      baseRevision: Number.isFinite(base) ? base : 0,
      targetRevision: Number.isFinite(target) ? target : 0,
    },
  })
})
