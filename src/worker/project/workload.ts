import type { ProjectWorkloadCard, ProjectWorkloadReport, ProjectWorkloadUser, ProjectProperty } from '@shared/project/model'
import { projectMultiValueIds } from '@shared/project/model'
import { projectPropertyVisibleTo, parseProjectPropertyConfig } from '@shared/project/property-config'
import { mergeSettings } from '@shared/constants'
import { visibleProjectBoards, type ProjectBoardRow, type ProjectMembershipRow } from './permissions'
import { projectIdChunks, projectPlaceholders } from './d1'

const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 92

interface PropertyRow {
  board_id: string
  id: string
  name: string
  type: string
  options: string
  config: string | null
}

interface ValueRow {
  card_id: string
  board_id: string
  title: string
  property_id: string
  value: string
}

interface TimeRow {
  user_id: string
  card_id: string
  board_id: string
  title: string
  milliseconds: number
}

interface UserRow {
  id: string
  name: string
  avatar_url: string
  settings: string
}

export async function readProjectWorkload(
  db: D1Database,
  userId: string,
  from: number,
  to: number,
  now: number,
): Promise<ProjectWorkloadReport> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_DAYS * DAY_MS) {
    throw new Error('Invalid workload range')
  }
  const [{ results: boardRows }, { results: membershipRows }] = await Promise.all([
    db.prepare(
      `SELECT b.* FROM project_boards b
       LEFT JOIN project_board_members m ON m.board_id = b.id AND m.user_id = ?1
       WHERE b.delete_at = 0 AND b.archived = 0 AND b.is_template = 0
         AND (b.owner_id = ?1 OR m.user_id IS NOT NULL OR (b.type = 'O' AND b.minimum_role <> ''))`,
    ).bind(userId).all<ProjectBoardRow>(),
    db.prepare('SELECT board_id, role FROM project_board_members WHERE user_id = ?1').bind(userId).all<ProjectMembershipRow>(),
  ])
  const boards = visibleProjectBoards(boardRows, membershipRows, userId)
  if (boards.length === 0) return { from, to, users: [], cards: [] }
  const boardById = new Map(boards.map((board) => [board.id, board]))
  const visibleProperties = new Map<string, Map<string, ProjectProperty>>()
  for (const chunk of projectIdChunks(boards.map((board) => board.id))) {
    const marks = projectPlaceholders(chunk.length)
    const { results } = await db.prepare(
      `SELECT p.board_id, p.id, p.name, p.type, p.options, pc.config
       FROM project_properties p
       LEFT JOIN project_property_configs pc ON pc.board_id = p.board_id AND pc.property_id = p.id
       WHERE p.board_id IN (${marks}) AND p.type IN ('person', 'multiPerson', 'estimate')`,
    ).bind(...chunk).all<PropertyRow>()
    for (const row of results) {
      const board = boardById.get(row.board_id)
      if (!board) continue
      const property: ProjectProperty = {
        id: row.id,
        name: row.name,
        type: row.type as ProjectProperty['type'],
        options: JSON.parse(row.options) as ProjectProperty['options'],
        config: row.config ? parseProjectPropertyConfig(row.config) : undefined,
      }
      if (!projectPropertyVisibleTo(property, board.role)) continue
      const byBoard = visibleProperties.get(row.board_id) ?? new Map()
      byBoard.set(row.id, property)
      visibleProperties.set(row.board_id, byBoard)
    }
  }

  const cards = new Map<string, ProjectWorkloadCard>()
  for (const chunk of projectIdChunks(boards.map((board) => board.id))) {
    const marks = projectPlaceholders(chunk.length)
    const { results } = await db.prepare(
      `SELECT c.id AS card_id, c.board_id, c.title, v.property_id, v.value
       FROM project_cards c
       JOIN project_card_values v ON v.card_id = c.id
       JOIN project_properties p ON p.board_id = c.board_id AND p.id = v.property_id
       WHERE c.delete_at = 0 AND c.board_id IN (${marks}) AND p.type IN ('person', 'multiPerson', 'estimate')`,
    ).bind(...chunk).all<ValueRow>()
    for (const row of results) {
      const property = visibleProperties.get(row.board_id)?.get(row.property_id)
      if (!property) continue
      const card = cards.get(row.card_id) ?? {
        cardId: row.card_id,
        boardId: row.board_id,
        boardTitle: boardById.get(row.board_id)?.title ?? '',
        title: row.title,
        estimateMinutes: 0,
        actualMinutes: 0,
        assigneeIds: [],
      }
      if (property.type === 'estimate') {
        const hours = Number(row.value)
        if (Number.isFinite(hours) && hours >= 0) card.estimateMinutes += Math.round(hours * 60)
      } else {
        for (const assigneeId of projectMultiValueIds(row.value)) {
          if (!card.assigneeIds.includes(assigneeId)) card.assigneeIds.push(assigneeId)
        }
      }
      cards.set(row.card_id, card)
    }
  }

  const actualByUser = new Map<string, number>()
  for (const chunk of projectIdChunks(boards.map((board) => board.id))) {
    const marks = projectPlaceholders(chunk.length, 4)
    const { results } = await db.prepare(
      `SELECT t.user_id, t.card_id, t.board_id, c.title,
              SUM(MIN(COALESCE(t.ended_at, ?1), ?2) - MAX(t.started_at, ?3)) AS milliseconds
       FROM project_time_entries t
       JOIN project_cards c ON c.id = t.card_id AND c.delete_at = 0
       WHERE t.board_id IN (${marks}) AND t.started_at < ?2 AND (t.ended_at IS NULL OR t.ended_at > ?3)
       GROUP BY t.user_id, t.card_id, t.board_id, c.title`,
    ).bind(now, to, from, ...chunk).all<TimeRow>()
    for (const row of results) {
      const milliseconds = Math.max(0, Math.round(row.milliseconds))
      const minutes = Math.max(0, Math.round(milliseconds / 60_000))
      actualByUser.set(row.user_id, (actualByUser.get(row.user_id) ?? 0) + minutes)
      const card = cards.get(row.card_id) ?? {
        cardId: row.card_id,
        boardId: row.board_id,
        boardTitle: boardById.get(row.board_id)?.title ?? '',
        title: row.title,
        estimateMinutes: 0,
        actualMinutes: 0,
        assigneeIds: [],
      }
      card.actualMinutes += minutes
      cards.set(row.card_id, card)
    }
  }

  const userIds = new Set<string>([userId, ...actualByUser.keys()])
  for (const card of cards.values()) for (const assigneeId of card.assigneeIds) userIds.add(assigneeId)
  const users = new Map<string, ProjectWorkloadUser>()
  for (const chunk of projectIdChunks([...userIds])) {
    const marks = projectPlaceholders(chunk.length)
    const { results } = await db.prepare(`SELECT id, name, avatar_url, settings FROM users WHERE id IN (${marks})`).bind(...chunk).all<UserRow>()
    for (const row of results) {
      let settings = mergeSettings({})
      try {
        settings = mergeSettings(JSON.parse(row.settings || '{}') as unknown)
      } catch (error) {
        console.warn('[inkstone] workload settings parse failed:', row.id, error instanceof Error ? error.message : error)
      }
      const capacityMinutes = Math.round(settings.project.capacityMinutesPerWeek * ((to - from) / (7 * DAY_MS)))
      users.set(row.id, {
        userId: row.id,
        name: row.name,
        avatarUrl: row.avatar_url,
        capacityMinutes,
        estimatedMinutes: 0,
        actualMinutes: actualByUser.get(row.id) ?? 0,
        cardCount: 0,
      })
    }
  }
  for (const card of cards.values()) {
    for (const assigneeId of card.assigneeIds) {
      const user = users.get(assigneeId)
      if (!user) continue
      user.estimatedMinutes += card.estimateMinutes
      user.cardCount += 1
    }
  }
  return {
    from,
    to,
    users: [...users.values()].sort((left, right) => right.actualMinutes - left.actualMinutes || right.estimatedMinutes - left.estimatedMinutes),
    cards: [...cards.values()].sort((left, right) => right.actualMinutes - left.actualMinutes || right.estimateMinutes - left.estimateMinutes),
  }
}

export function defaultWorkloadRange(now: number): { from: number, to: number } {
  const date = new Date(now)
  const day = date.getUTCDay()
  const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - ((day + 6) % 7) * DAY_MS
  return { from, to: from + 7 * DAY_MS }
}
