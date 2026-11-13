/**
 * D-7: a comment notifies the members it @mentions and the subscribers watching the card or board.
 * The target set is a pure function so tests can pin it; delivery is best-effort because a refused
 * notice must never refuse the comment itself.
 */
import { mergeSettings } from '@shared/constants'
import type { AppBindings } from '../env'
import { AssistantStore } from '../assistant/store'
import { storedObject } from '../lib/json'
import { projectCommentMentionedIds, projectCommentNotificationTargets } from '@shared/project/mentions'
import type { ProjectNotificationLevel } from '@shared/constants'

/** The account's choice for this board: all notices, only direct ones, or none. */
async function notificationLevel(db: D1Database, boardId: string, userId: string): Promise<ProjectNotificationLevel> {
  const row = await db.prepare('SELECT settings FROM users WHERE id = ?1').bind(userId).first<{ settings: string }>()
  return mergeSettings(storedObject(row?.settings ?? '')).project.notifications[boardId] ?? 'all'
}

export async function notifyProjectAssignment(
  db: D1Database,
  env: AppBindings['Bindings'],
  input: { boardId: string, cardId: string, cardTitle: string, actorId: string, assigneeIds: readonly string[] },
): Promise<void> {
  for (const assigneeId of new Set(input.assigneeIds)) {
    if (!assigneeId || assigneeId === input.actorId) continue
    if (await notificationLevel(db, input.boardId, assigneeId) === 'off') continue
    await new AssistantStore(db, assigneeId, env).createNotification({
      title: `Assigned to ${input.cardTitle}`.slice(0, 200),
      body: input.cardTitle,
      link: `project:${input.boardId}:${input.cardId}`,
    })
  }
}

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
  const memberIds = members.results.map((row) => row.user_id)
  const mentioned = new Set(projectCommentMentionedIds(memberIds, input.body, names))
  const targets = projectCommentNotificationTargets(memberIds, watchers.results.map((row) => row.subscriber_id), input.body, input.authorId, names)
  for (const target of targets) {
    const level = await notificationLevel(db, input.boardId, target)
    if (level === 'off') continue
    if (level === 'mentions' && !mentioned.has(target)) continue
    await new AssistantStore(db, target, env).createNotification({
      title: `New comment on ${input.cardTitle}`.slice(0, 200),
      body: input.body,
      link: `project:${input.boardId}:${input.cardId}`,
    })
  }
}

export async function notifyProjectAutomation(
  db: D1Database,
  env: AppBindings['Bindings'],
  input: { boardId: string, cardTitle: string, ownerId: string, message: string },
): Promise<void> {
  if (!input.ownerId) return
  await new AssistantStore(db, input.ownerId, env).createNotification({
    title: input.message.slice(0, 200),
    body: input.cardTitle,
    link: `project:${input.boardId}`,
  })
}