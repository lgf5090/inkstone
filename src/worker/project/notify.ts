/**
 * D-7: a comment notifies the members it @mentions and the subscribers watching the card or board.
 * The target set is a pure function so tests can pin it; delivery is best-effort because a refused
 * notice must never refuse the comment itself.
 */
import type { AppBindings } from '../env'
import { AssistantStore } from '../assistant/store'
import { projectCommentNotificationTargets } from '@shared/project/mentions'

export async function notifyProjectComment(
  db: D1Database,
  env: AppBindings['Bindings'],
  input: { boardId: string, cardId: string, cardTitle: string, body: string, authorId: string },
): Promise<void> {
  const members = await db.prepare(
    `SELECT m.user_id, u.name, u.username FROM project_board_members m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.board_id = ?1`,
  ).bind(input.boardId).all<{ user_id: string, name: string | null, username: string | null }>()
  const watchers = await db.prepare('SELECT subscriber_id FROM project_subscriptions WHERE (block_id = ?1 OR block_id = ?2) AND delete_at = 0').bind(input.cardId, input.boardId).all<{ subscriber_id: string }>()
  const names = Object.fromEntries(members.results.map((row) => [row.user_id, row.name || row.username || '']))
  const targets = projectCommentNotificationTargets(members.results.map((row) => row.user_id), watchers.results.map((row) => row.subscriber_id), input.body, input.authorId, names)
  for (const target of targets) {
    await new AssistantStore(db, target, env).createNotification({
      title: `New comment on ${input.cardTitle}`.slice(0, 200),
      body: input.body,
      link: `project:${input.boardId}:${input.cardId}`,
    })
  }
}