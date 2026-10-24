import { EMAIL_SNOOZE_WAKE_BATCH } from '@shared/email/model'
import type { Env } from '../env'
import { emailMailbox } from './mailbox-stub'

export const EMAIL_SNOOZE_ACCOUNT_PAGE_SIZE = 50

interface AccountRow {
  id: string
}

export interface EmailSnoozeWakeResult {
  accounts: number
  messages: number
}

export async function runEmailSnoozeWake(
  env: Env,
  now = Date.now(),
): Promise<EmailSnoozeWakeResult> {
  const result: EmailSnoozeWakeResult = { accounts: 0, messages: 0 }
  if (!env.EMAIL_MAILBOX) {
    console.warn('[inkstone] email snooze wake skipped: EMAIL_MAILBOX is not configured')
    return result
  }

  let cursor = ''
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM email_accounts WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
    ).bind(cursor, EMAIL_SNOOZE_ACCOUNT_PAGE_SIZE).all<AccountRow>()
    if (!results.length) break

    for (const account of results) {
      try {
        const woken = await emailMailbox(env, account.id).wakeSnoozed(now, EMAIL_SNOOZE_WAKE_BATCH)
        result.messages += woken.length
      } catch (error) {
        console.warn(`[inkstone] email snooze wake failed for mailbox ${account.id}:`, (error as Error).message)
      }
    }

    result.accounts += results.length
    cursor = results[results.length - 1]!.id
    if (results.length < EMAIL_SNOOZE_ACCOUNT_PAGE_SIZE) break
  }
  return result
}
