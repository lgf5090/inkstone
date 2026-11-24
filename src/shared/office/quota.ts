import { OFFICE_LIMITS } from './constants'

/**
 * Whether a write would spend more of the account's Office storage than it has.
 *
 * `replacing` is the bytes the write overwrites — a re-saved file keeps its own size out of the sum, so
 * editing a file that is already large never fails just because the account is near its ceiling.
 */
export function officeBytesExceeded(used: number, incoming: number, replacing = 0): boolean {
  return used - replacing + incoming > OFFICE_LIMITS.bytesPerUser
}
