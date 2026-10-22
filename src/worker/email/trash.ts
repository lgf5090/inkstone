import { EMAIL_TRASH_RETENTION_DAYS } from '@shared/email/model'
import { deleteAttachmentObjects } from '../attachments/backend'
import type { Env } from '../env'
import { deleteEmailAttachments } from './attachments'
import { emailMailbox } from './mailbox-stub'

export const EMAIL_TRASH_ACCOUNT_PAGE_SIZE = 50

const DAY_MS = 24 * 60 * 60 * 1000

interface OwnerAccountRow {
  id: string
  user_id: string
}

export interface EmailTrashCleanupResult {
  accounts: number
  messages: number
  attachments: number
}

export async function runEmailTrashCleanup(
  env: Env,
  now = Date.now(),
): Promise<EmailTrashCleanupResult> {
  const result: EmailTrashCleanupResult = { accounts: 0, messages: 0, attachments: 0 }
  if (!env.EMAIL_MAILBOX) {
    console.warn('[inkstone] email trash cleanup skipped: EMAIL_MAILBOX is not configured')
    return result
  }

  const cutoff = now - EMAIL_TRASH_RETENTION_DAYS * DAY_MS
  let cursor = ''
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.user_id FROM email_accounts a
         JOIN users u ON u.id = a.user_id
        WHERE u.role = 'owner' AND a.id > ?1
        ORDER BY a.id ASC LIMIT ?2`,
    ).bind(cursor, EMAIL_TRASH_ACCOUNT_PAGE_SIZE).all<OwnerAccountRow>()
    if (!results.length) break

    for (const account of results) {
      try {
        const messageIds = await emailMailbox(env, account.id).purgeExpiredTrash(cutoff)
        if (!messageIds.length) continue
        result.messages += messageIds.length
        await removeAttachments(env, account.user_id, messageIds, result)
      } catch (error) {
        console.warn('[inkstone] email trash cleanup failed for one mailbox', error)
      }
    }

    result.accounts += results.length
    cursor = results[results.length - 1]!.id
    if (results.length < EMAIL_TRASH_ACCOUNT_PAGE_SIZE) break
  }
  return result
}

async function removeAttachments(
  env: Env,
  userId: string,
  messageIds: readonly string[],
  result: EmailTrashCleanupResult,
): Promise<void> {
  const keys = await deleteEmailAttachments(env.DB, userId, messageIds)
  result.attachments += keys.length
  if (!keys.length) return
  if (!env.FILES) {
    console.warn('[inkstone] email attachment objects could not be removed: R2 is not configured')
    return
  }
  try {
    await deleteAttachmentObjects(env, 'r2', keys)
  } catch (error) {
    console.warn('[inkstone] email attachment objects could not be removed', error)
  }
}
