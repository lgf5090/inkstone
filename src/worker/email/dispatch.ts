import { initializeDatabase } from '../db/schema'
import type { Env } from '../env'
import { findEmailAccountByAddress } from './account-store'
import { handleInboundMail, mailDomain, recipientToken } from './inbound'
import { handleMailboxInbound, normalizeEnvelopeAddress } from './mailbox'

export async function dispatchInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const domain = mailDomain(env)
  if (domain && recipientToken(message.to, domain)) {
    await handleInboundMail(message, env)
    return
  }

  await initializeDatabase(env)
  const address = normalizeEnvelopeAddress(message.to)
  const account = await findEmailAccountByAddress(env.DB, address)
  if (!account) {
    console.warn(domain
      ? '[inkstone] inbound mail dropped: the recipient names no mailbox'
      : '[inkstone] inbound mail dropped: MAIL_DOMAIN is not configured and the recipient names no mailbox')
    return
  }
  if (account.role !== 'owner') {
    console.warn('[inkstone] inbound mail dropped: the mailbox belongs to a non-owner account')
    return
  }
  await handleMailboxInbound(message, account, env, ctx)
}
