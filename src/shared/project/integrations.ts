/**
 * The vocabulary shared by the API-token and webhook endpoints and their dialog.
 *
 * A webhook event names the write that produced it, not the entity's whole history: the payload is a
 * small envelope (board, target, method) so a delivery never carries card bodies or member names.
 */
export const PROJECT_WEBHOOK_EVENTS = ['card.created', 'card.updated', 'card.deleted', 'board.changed'] as const
export type ProjectWebhookEvent = (typeof PROJECT_WEBHOOK_EVENTS)[number]

export const PROJECT_TOKEN_SCOPES = ['read', 'write'] as const
export type ProjectTokenScope = (typeof PROJECT_TOKEN_SCOPES)[number]

export const PROJECT_TOKEN_PREFIX = 'pj_'
export const PROJECT_WEBHOOK_SECRET_PREFIX = 'whsec_'
export const PROJECT_WEBHOOK_MAX_ATTEMPTS = 5

/** A card create has no id in its path; every other card write addresses one. */
export function projectWebhookEvent(method: string, path: string): ProjectWebhookEvent {
  const verb = method.toUpperCase()
  if (verb === 'POST' && /\/cards$/.test(path)) return 'card.created'
  if (/^\/api\/project\/cards\/[^/]+$/.test(path)) {
    if (verb === 'DELETE') return 'card.deleted'
    if (verb === 'PATCH' || verb === 'PUT') return 'card.updated'
  }
  return 'board.changed'
}

export function projectWebhookMatches(events: readonly string[], event: ProjectWebhookEvent): boolean {
  return events.includes('*') || events.includes(event)
}

/** Exponential backoff, starting at one minute and capped at one hour. */
export function projectWebhookRetryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000)
}
