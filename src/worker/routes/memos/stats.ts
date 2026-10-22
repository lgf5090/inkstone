import { Hono } from 'hono'
import { MEMO_ORDER_FIELDS, type MemoOrderField } from '@shared/memos/types'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { requireMemoUser } from '../../memos/auth'
import { getMemoStats, type MemoStatsOptions } from '../../memos/stats'

function parseBound(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d+$/.test(value)) throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  }
  return parsed
}

function parseTimeBasis(value: string | undefined): MemoOrderField | undefined {
  if (value === undefined || value === '') return undefined
  if (!(MEMO_ORDER_FIELDS as readonly string[]).includes(value)) {
    throw ApiError.badRequest('timeBasis must be created or updated')
  }
  return value as MemoOrderField
}

function parseSpaceId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (!isValidId(value)) throw ApiError.badRequest('spaceId must be a valid id')
  return value
}

export const memoStatsRoutes = new Hono<AppBindings>()

memoStatsRoutes.use('*', requireMemoUser)

memoStatsRoutes.get('/', async (c) => {
  const options: MemoStatsOptions = {
    spaceId: parseSpaceId(c.req.query('spaceId')),
    from: parseBound(c.req.query('from'), 'from'),
    to: parseBound(c.req.query('to'), 'to'),
    tz: c.req.query('tz') || undefined,
    timeBasis: parseTimeBasis(c.req.query('timeBasis')),
  }
  return c.json(await getMemoStats(c.env.DB, c.get('userId'), options))
})
