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
import { EN_US_PROJECT_NOTIFY } from '@shared/locales/en-US-project-notify'
import { ZH_CN_PROJECT_NOTIFY } from '@shared/locales/zh-CN-project-notify'
import { projectRoleForBoard } from './visibility'

function fill(template: string, title: string): string {
  return template.replace('{title}', () => title)
}

/** The account's choice for this board: all notices, only direct ones, or none. */
async function notificationPreference(db: D1Database, boardId: string, userId: string): Promise<{ level: ProjectNotificationLevel, locale: 'en-US' | 'zh-CN' }> {
  const row = await db.prepare('SELECT settings FROM users WHERE id = ?1').bind(userId).first<{ settings: string }>()
  const settings = mergeSettings(storedObject(row?.settings ?? ''))
  return {
    level: settings.project.notifications[boardId] ?? 'all',
    locale: settings.appearance.language === 'en-US' ? 'en-US' : 'zh-CN',
  }
}

export async function notifyProjectAssignment(
  db: D1Database,
  env: AppBindings['Bindings'],
  input: { boardId: string, cardId: string, cardTitle: string, actorId: string, assigneeIds: readonly string[] },
): Promise<void> {
  for (const assigneeId of new Set(input.assigneeIds)) {
    if (!assigneeId || assigneeId === input.actorId) continue
    if (!await projectRoleForBoard(db, input.boardId, assigneeId)) continue
    const preference = await notificationPreference(db, input.boardId, assigneeId)
    if (preference.level === 'off') continue
    const copy = preference.locale === 'en-US' ? EN_US_PROJECT_NOTIFY : ZH_CN_PROJECT_NOTIFY
    await new AssistantStore(db, assigneeId, env).createNotification({
      title: fill(copy.assigned, input.cardTitle).slice(0, 200),
      body: input.cardTitle,
      link: `project:${input.boardId}:${input.cardId}`,
    })
  }
}

export async function notifyProjectReminder(
  db: D1Database,
  env: AppBindings['Bindings'],
  input: {
    boardId: string
    cardId: string
    propertyId: string
    dueAt: number
    cardTitle: string
    subscriberIds: readonly string[]
  },
): Promise<string[]> {
  const delivered: string[] = []
  for (const subscriberId of new Set(input.subscriberIds)) {
    if (!await projectRoleForBoard(db, input.boardId, subscriberId)) continue
    const preference = await notificationPreference(db, input.boardId, subscriberId)
    if (preference.level === 'off') continue
    const copy = preference.locale === 'en-US' ? EN_US_PROJECT_NOTIFY : ZH_CN_PROJECT_NOTIFY
    await new AssistantStore(db, subscriberId, env).createNotification({
      id: `project-reminder:${input.boardId}:${input.cardId}:${input.propertyId}:${input.dueAt}:${subscriberId}`,
      title: fill(copy.due, input.cardTitle).slice(0, 200),
      body: input.cardTitle,
      link: `project:${input.boardId}:${input.cardId}`,
    })
    delivered.push(subscriberId)
  }
  return delivered
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
    if (!await projectRoleForBoard(db, input.boardId, target)) continue
    const preference = await notificationPreference(db, input.boardId, target)
    if (preference.level === 'off') continue
    if (preference.level === 'mentions' && !mentioned.has(target)) continue
    const copy = preference.locale === 'en-US' ? EN_US_PROJECT_NOTIFY : ZH_CN_PROJECT_NOTIFY
    await new AssistantStore(db, target, env).createNotification({
      title: fill(copy.comment, input.cardTitle).slice(0, 200),
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