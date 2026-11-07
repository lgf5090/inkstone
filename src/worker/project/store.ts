import type { ProjectBoardSummary } from '@shared/project/model'
import { visibleProjectBoards, type ProjectBoardRow, type ProjectMembershipRow } from './permissions'

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
        `SELECT * FROM project_boards
         WHERE delete_at = 0 AND is_template = 0
           AND (owner_id = ?1
                OR id IN (SELECT board_id FROM project_board_members WHERE user_id = ?1))
         ORDER BY update_at DESC`,
      )
      .bind(this.userId)
      .all<ProjectBoardRow>()
    const { results: memberships } = await this.db
      .prepare('SELECT board_id, role FROM project_board_members WHERE user_id = ?1')
      .bind(this.userId)
      .all<ProjectMembershipRow>()
    return visibleProjectBoards(results, memberships, this.userId)
  }
}