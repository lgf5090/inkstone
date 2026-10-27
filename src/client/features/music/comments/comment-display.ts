/** Presentation helpers shared by the comments pane and the quiet-stretch card. */
import { musicApi } from '../api'

/** A provider avatar is remote, so it goes through the same image proxy as provider covers. */
export function commentAvatarUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined
  return /^https?:\/\//i.test(trimmed) ? musicApi.providerCoverUrl(trimmed) : trimmed
}
