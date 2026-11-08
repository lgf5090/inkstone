import type { WebsshEgressFailure } from '@shared/webssh/types'

/**
 * The one region move a terminal may make. The server only fills `retryRegion` in automatic mode,
 * and the Durable Object cannot move after creation, so the client opens a new session for it.
 */
export function regionRetryTarget(failure: WebsshEgressFailure | undefined, used: boolean): string | null {
  if (used || !failure?.retryable || !failure.retryRegion) return null
  return failure.retryRegion
}
