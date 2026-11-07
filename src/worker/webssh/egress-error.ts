import type {
  WebsshEgressFailure,
  WebsshEgressMode,
  WebsshEgressPhase,
} from '@shared/webssh/types'

export interface ErrorDetails {
  name: string
  message: string
}

/** Placeholder messages that carry no diagnostic value once a deeper cause exists. */
const GENERIC_MESSAGES = new Set(['', '[object Object]', 'Error', 'undefined', 'null'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  return String(value)
}

function describeOne(error: unknown): ErrorDetails {
  if (typeof error === 'string') return { name: 'Error', message: error }
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message || messageOf(error) }
  }
  if (isRecord(error)) {
    const name = typeof error.name === 'string' && error.name ? error.name : 'Error'
    const message = typeof error.message === 'string' ? error.message : messageOf(error)
    return { name, message }
  }
  return { name: 'Error', message: messageOf(error) }
}

/**
 * The deepest useful `name`/`message` in an error's `cause` chain.
 *
 * Workers can reject a socket with a platform object that is not an `Error`, and the protocol core
 * wraps that object as a cause. Reading only the outer message turns every one of those into a
 * generic sentence, which is what made the original `proxy request failed` report impossible to
 * diagnose. `String(error)` remains the final fallback.
 */
export function describeError(error: unknown): ErrorDetails {
  const seen = new Set<unknown>()
  const chain: ErrorDetails[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    chain.push(describeOne(current))
    if (isRecord(current) && 'cause' in current) current = current.cause
    else break
  }
  if (chain.length === 0) return { name: 'Error', message: messageOf(error) }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]
    if (candidate && !GENERIC_MESSAGES.has(candidate.message.trim())) return candidate
  }
  return chain[0] as ErrorDetails
}

export interface EgressAttemptContext {
  phase: WebsshEgressPhase
  address: string
  port: number
  startedAt: number
  mode: WebsshEgressMode
  region: string
  via?: string
  now?: number
}

export const WEBSSH_EGRESS_MESSAGE_MAX = 512

/** Shape one failure for the audit row and the browser frame without leaking a stack or a secret. */
export function toEgressFailure(error: unknown, context: EgressAttemptContext): WebsshEgressFailure {
  const detail = describeError(error)
  const elapsedMs = Math.max(0, Math.trunc((context.now ?? Date.now()) - context.startedAt))
  const message = detail.message.length > WEBSSH_EGRESS_MESSAGE_MAX
    ? `${detail.message.slice(0, WEBSSH_EGRESS_MESSAGE_MAX - 3)}...`
    : detail.message
  return {
    name: detail.name,
    message: message || 'unknown error',
    phase: context.phase,
    address: context.address,
    port: context.port,
    elapsedMs,
    mode: context.mode,
    region: context.region,
    ...(context.via ? { via: context.via } : {}),
  }
}
