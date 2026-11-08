/**
 * A calendar name that can travel in a `Content-Disposition` header.
 *
 * Provider and reader names may carry separators, control characters or a trailing dot; the
 * file is downloaded, not resolved, so the only job here is to keep the header one safe token.
 */
export function safeFilename(value: string, fallback: string): string {
  const cleaned = value.replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 120)
  return cleaned || fallback
}
