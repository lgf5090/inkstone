export const CERTHUB_EVENT_KINDS = [
  'account.registered',
  'account.rotated',
  'cert.expired',
  'cert.issued',
  'cert.revoked',
  'challenge.pending_dns',
  'challenge.prepared',
  'challenge.regenerated',
  'config.updated',
  'job.dead',
  'key.downloaded',
  'key.purged',
  'notify.sent',
  'order.canceled',
  'order.created',
  'order.deleted',
  'order.dns_provider_missing',
  'order.failed',
  'order.finalized',
  'order.provider_bound',
  'order.queued',
  'order.renewed',
  'provider.created',
  'provider.deleted',
  'provider.updated',
  'quota.updated',
  'renew.failed',
  'token.created',
  'token.revoked',
  'token.rotated',
] as const

export type CerthubEventKind = (typeof CERTHUB_EVENT_KINDS)[number]

export function eventKindKey(kind: string): string {
  return `development.certhub.event.${kind}`
}
