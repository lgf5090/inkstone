import type { ProjectBoardSummary } from '@shared/project/model'
import { rowToBoard, visibleProjectBoards, type ProjectBoardRow, type ProjectMembershipRow } from './permissions'

/**
 * The project app's reads and writes, in one place so no route file carries SQL.
 *
 * Board-scoped rows key on the board rather than the account, so every query here either names the
 * account explicitly (the boards it owns) or reaches it through the membership table.
 */
export class ProjectStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * Owned boards and boards shared with this account, in one statement: a per-membership lookup
   * would turn a sidebar of fifty boards into fifty round trips.
   */
  async boards(): Promise<ProjectBoardSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM project_cards c WHERE c.board_id = b.id AND c.delete_at = 0) AS card_count
         FROM project_boards b
         WHERE b.delete_at = 0 AND b.is_template = 0
           AND (b.owner_id = ?1
                OR b.id IN (SELECT board_id FROM project_board_members WHERE user_id = ?1))
         ORDER BY b.update_at DESC`,
      )
      .bind(this.userId)
      .all<ProjectBoardRow & { card_count: number }>()
    const { results: memberships } = await this.db
      .prepare('SELECT board_id, role FROM project_board_members WHERE user_id = ?1')
      .bind(this.userId)
      .all<ProjectMembershipRow>()
    const counts = new Map(results.map((row) => [row.id, row.card_count ?? 0]))
    return visibleProjectBoards(results, memberships, this.userId).map((board) => ({ ...board, cardCount: counts.get(board.id) ?? 0 }))
  }
  /** Soft-deleted boards this account owns: the restore list, which the live board list excludes. */
  async deletedBoards(): Promise<ProjectBoardSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM project_boards
         WHERE delete_at != 0 AND is_template = 0 AND owner_id = ?1
         ORDER BY delete_at DESC LIMIT 100`,
      )
      .bind(this.userId)
      .all<ProjectBoardRow>()
    return results.map((row) => ({ ...rowToBoard(row), role: 'admin' as const }))
  }
}
