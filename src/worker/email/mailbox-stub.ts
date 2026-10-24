import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import type { EmailMailbox } from './mailbox-do'

export function emailMailbox(env: Env, id: string): DurableObjectStub<EmailMailbox> {
  if (!env.EMAIL_MAILBOX) {
    throw new ApiError(503, 'email_mailbox_unavailable', 'Mailbox storage is not configured')
  }
  return env.EMAIL_MAILBOX.get(env.EMAIL_MAILBOX.idFromName(id)) as DurableObjectStub<EmailMailbox>
}
