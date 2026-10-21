import type { MemoOrderField, MemoStats, MemoTypeCounts } from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { spaceBelongsToUser } from './spaces'

const DEFAULT_TIMEZONE = 'UTC'

export interface MemoStatsOptions {
  spaceId?: string | null
  from?: number
  to?: number
  tz?: string
  timeBasis?: MemoOrderField
}

interface OverviewRow {
  total: number
  archived: number
  comments: number
}

interface TagCountRow {
  tag: string
  count: number
}

interface TypeCountRow {
  link: number
  code: number
  todo: number
  undo: number
}

interface BytesRow {
  bytes: number
}

interface DayRow {
  at: number
}

function resolveTimeZone(value: string | undefined): string {
  if (!value) return DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return DEFAULT_TIMEZONE
  }
}

function dayKeyReader(timeZone: string | undefined): (seconds: number) => string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (seconds) => {
    const parts = formatter.formatToParts(new Date(seconds * 1000))
    const read = (type: 'year' | 'month' | 'day'): string =>
      parts.find((part) => part.type === type)?.value ?? ''
    return `${read('year')}-${read('month')}-${read('day')}`
  }
}

function parseBound(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  }
  return value
}

function parseTimeBasis(value: MemoOrderField | undefined): MemoOrderField {
  if (value === undefined) return 'created'
  if (value !== 'created' && value !== 'updated') {
    throw ApiError.badRequest('timeBasis must be created or updated')
  }
  return value
}

export async function getMemoStats(
  db: D1Database,
  userId: string,
  options: MemoStatsOptions = {},
): Promise<MemoStats> {
  const from = parseBound(options.from, 'from')
  const to = parseBound(options.to, 'to')
  if (from !== undefined && to !== undefined && from >= to) {
    throw ApiError.badRequest('from must be less than to')
  }
  const timeBasis = parseTimeBasis(options.timeBasis)
  const spaceId = options.spaceId ?? null
  if (spaceId !== null && !(await spaceBelongsToUser(db, userId, spaceId))) {
    throw ApiError.notFound('Space not found')
  }

  const scopeSql = spaceId === null ? '' : ' AND i.space_id = ?2'
  const scopeParams: unknown[] = spaceId === null ? [userId] : [userId, spaceId]

  const overview = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN i.parent_id IS NULL AND i.state = 'normal' THEN 1 ELSE 0 END), 0) AS total,
         COALESCE(SUM(CASE WHEN i.parent_id IS NULL AND i.state = 'archived' THEN 1 ELSE 0 END), 0) AS archived,
         COALESCE(SUM(CASE WHEN i.parent_id IS NOT NULL AND i.state = 'normal' THEN 1 ELSE 0 END), 0) AS comments
       FROM memos_items i
       WHERE i.user_id = ?1${scopeSql}`,
    )
    .bind(...scopeParams)
    .first<OverviewRow>()

  const { results: tagRows } = await db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count
         FROM memos_tags t
         JOIN memos_items i ON i.id = t.memo_id
        WHERE i.user_id = ?1 AND i.state = 'normal' AND i.parent_id IS NULL${scopeSql}
        GROUP BY t.tag
        ORDER BY t.tag ASC`,
    )
    .bind(...scopeParams)
    .all<TagCountRow>()

  const typeRow = await db
    .prepare(
      `SELECT
         COALESCE(SUM(i.has_link), 0) AS link,
         COALESCE(SUM(i.has_code), 0) AS code,
         COALESCE(SUM(i.has_task_list), 0) AS todo,
         COALESCE(SUM(i.has_incomplete_tasks), 0) AS undo
       FROM memos_items i
       WHERE i.user_id = ?1 AND i.state = 'normal' AND i.parent_id IS NULL${scopeSql}`,
    )
    .bind(...scopeParams)
    .first<TypeCountRow>()

  const bytesRow = spaceId === null
    ? await db
        .prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM memos_attachments WHERE user_id = ?1')
        .bind(userId)
        .first<BytesRow>()
    : await db
        .prepare(
          `SELECT COALESCE(SUM(a.size), 0) AS bytes
             FROM memos_attachments a
             JOIN memos_items i ON i.id = a.memo_id AND i.user_id = a.user_id
            WHERE a.user_id = ?1 AND i.space_id = ?2`,
        )
        .bind(userId, spaceId)
        .first<BytesRow>()

  const dayColumn = timeBasis === 'updated' ? 'updated_at' : 'created_at'
  const dayWhere = ['i.user_id = ?1', `i.state = 'normal'`, 'i.parent_id IS NULL']
  const dayParams: unknown[] = [userId]
  if (spaceId !== null) {
    dayParams.push(spaceId)
    dayWhere.push(`i.space_id = ?${dayParams.length}`)
  }
  if (from !== undefined) {
    dayParams.push(from)
    dayWhere.push(`i.${dayColumn} >= ?${dayParams.length}`)
  }
  if (to !== undefined) {
    dayParams.push(to)
    dayWhere.push(`i.${dayColumn} < ?${dayParams.length}`)
  }
  const { results: dayRows } = await db
    .prepare(`SELECT i.${dayColumn} AS at FROM memos_items i WHERE ${dayWhere.join(' AND ')}`)
    .bind(...dayParams)
    .all<DayRow>()

  const readDay = dayKeyReader(options.tz)
  const dayCounts = new Map<string, number>()
  for (const row of dayRows) {
    const key = readDay(row.at)
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1)
  }

  const tagCounts = new Map<string, number>()
  for (const row of tagRows) tagCounts.set(row.tag, Number(row.count))

  const typeCounts: MemoTypeCounts = {
    link: Number(typeRow?.link ?? 0),
    code: Number(typeRow?.code ?? 0),
    todo: Number(typeRow?.todo ?? 0),
    undo: Number(typeRow?.undo ?? 0),
  }

  return {
    total: Number(overview?.total ?? 0),
    archived: Number(overview?.archived ?? 0),
    comments: Number(overview?.comments ?? 0),
    attachmentBytes: Number(bytesRow?.bytes ?? 0),
    tagCounts: Object.fromEntries(tagCounts),
    typeCounts,
    dayCounts: Object.fromEntries(dayCounts),
  }
}
