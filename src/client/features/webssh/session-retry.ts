/** The client's reconnect ladder. The server (W2) never drives retries; the UI does. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length

export type RetryDecision =
  | { action: 'retry'; attempt: number; delayMs: number }
  | { action: 'exhausted'; attempt: number }

/** `attempt` is the number of the retry being decided, starting at 1. */
export function nextRetryDecision(attempt: number): RetryDecision {
  const delayMs = RECONNECT_DELAYS_MS[attempt - 1]
  if (delayMs === undefined) return { action: 'exhausted', attempt: MAX_RECONNECT_ATTEMPTS }
  return { action: 'retry', attempt, delayMs }
}
