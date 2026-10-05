import type { Env } from '../env'
import { timingSafeEqual } from './encoding'

export type InternalGuardState = 'allowed' | 'denied' | 'misconfigured'

/**
 * The Durable Object guard is opt-in, but a secret that was created and left blank reads
 * as falsy, which silently switches the guard off. Say so instead.
 */
export function evaluateInternalGuard(env: Env | undefined, request: Request): InternalGuardState {
  const configured = env?.DO_AUTH_KEY
  if (configured === undefined) return 'allowed'
  if (!configured.trim()) return 'misconfigured'
  return timingSafeEqual(request.headers.get('X-Inkstone-Internal') ?? '', configured)
    ? 'allowed'
    : 'denied'
}
