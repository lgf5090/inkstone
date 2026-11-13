/**
 * The cards across every readable board that name the reader in a person property.
 *
 * A board the reader merely can open still counts, because an open board's cards are visible even
 * without a membership row; a card on a board they cannot read never appears. Dates are read in the
 * zone the value was written in, so the grouping lands on the author's day rather than UTC's.
 */
import type { ProjectMyTask } from '@shared/project/model'
import { parseProjectDateValue, projectStampToDay } from '@shared/project/date'

interface TaskRow {
  card_id: string
  board_id: string
  title: string
  update_at: number
  board_title: string
  board_icon: string
}

interface DateRow {
  card_id: string
  value: string
}

const MAX_TASKS = 500

export async function listProjectMyTasks(db: D1Database, userId: string): Promise<ProjectMyTask[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT c.id AS card_id, c.board_id, c.title, c.update_at,
            b.title AS board_title, b.icon AS board_icon
       FROM project_cards c
       JOIN project_boards b ON b.id = c.board_id AND b.delete_at = 0
       JOIN project_card_values v ON v.card_id = c.id
       JOIN project_properties p ON p.board_id = c.board_id AND p.id = v.property_id
       LEFT JOIN project_board_members m ON m.board_id = b.id AND m.user_id = ?1
      WHERE c.delete_at = 0
        AND p.type IN ('person', 'multiPerson')
        AND (v.value = ?1 OR (p.type = 'multiPerson' AND v.value LIKE ?2))
        AND (m.user_id IS NOT NULL OR (b.type = 'O' AND b.minimum_role <> ''))
      ORDER BY c.update_at DESC
      LIMIT ?3`,
  ).bind(userId, `%"${userId}"%`, MAX_TASKS).all<TaskRow>()
  if (results.length === 0) return []

  const cardIds = results.map((row) => row.card_id)
  const placeholders = cardIds.map((_, index) => `?${index + 1}`).join(', ')
  const dates = await db.prepare(
    `SELECT v.card_id, v.value
       FROM project_card_values v
       JOIN project_cards c ON c.id = v.card_id
       JOIN project_properties p ON p.board_id = c.board_id AND p.id = v.property_id
      WHERE v.card_id IN (${placeholders}) AND p.type = 'date'`,
  ).bind(...cardIds).all<DateRow>()

  const dueByCard = new Map<string, number>()
  for (const row of dates.results) {
    const value = parseProjectDateValue(row.value)
    const stamp = value?.to ?? value?.from
    if (stamp === undefined) continue
    const day = projectStampToDay(stamp, value?.includeTime === true, value?.timeZone).getTime()
    const current = dueByCard.get(row.card_id)
    if (current === undefined || day < current) dueByCard.set(row.card_id, day)
  }

  return results
    .map((row) => ({
      cardId: row.card_id,
      boardId: row.board_id,
      boardTitle: row.board_title,
      boardIcon: row.board_icon,
      title: row.title,
      dueAt: dueByCard.get(row.card_id) ?? null,
      updatedAt: row.update_at,
    }))
    .sort((left, right) => {
      if (left.dueAt === right.dueAt) return right.updatedAt - left.updatedAt
      if (left.dueAt === null) return 1
      if (right.dueAt === null) return -1
      return left.dueAt - right.dueAt
    })
}
