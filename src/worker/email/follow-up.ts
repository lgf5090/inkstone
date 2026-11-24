import { EMAIL_FOLLOW_UP_WAKE_BATCH } from '@shared/email/model'
import type { Env } from '../env'
import { emailMailbox } from './mailbox-stub'
import { createEmailNotification } from './notifications'

export const EMAIL_FOLLOW_UP_ACCOUNT_PAGE_SIZE = 50

interface AccountRow {
  id: string
  user_id: string
}

export interface EmailFollowUpSweepResult {
  accounts: number
  messages: number
}

export async function runEmailFollowUpSweep(
  env: Env,
  now = Date.now(),
): Promise<EmailFollowUpSweepResult> {
  const result: EmailFollowUpSweepResult = { accounts: 0, messages: 0 }
  if (!env.EMAIL_MAILBOX) {
    console.warn('[inkstone] email follow-up sweep skipped: EMAIL_MAILBOX is not configured')
    return result
  }

  let cursor = ''
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id FROM email_accounts WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
    ).bind(cursor, EMAIL_FOLLOW_UP_ACCOUNT_PAGE_SIZE).all<AccountRow>()
    if (!results.length) break

    for (const account of results) {
      try {
        const woken = await emailMailbox(env, account.id).wakeFollowUps(now, EMAIL_FOLLOW_UP_WAKE_BATCH)
        result.messages += woken.length
        if (woken.length) {
          await createEmailNotification(env, account.user_id, {
            title: `Email follow-ups due: ${woken.length}`,
            body: 'Open the notification centre to review your mailbox.',
            link: `email-followups:${account.id}`,
          })
        }
      } catch (error) {
        console.warn(`[inkstone] email follow-up sweep failed for mailbox ${account.id}:`, (error as Error).message)
      }
    }

    result.accounts += results.length
    cursor = results[results.length - 1]!.id
    if (results.length < EMAIL_FOLLOW_UP_ACCOUNT_PAGE_SIZE) break
  }
  return result
}
