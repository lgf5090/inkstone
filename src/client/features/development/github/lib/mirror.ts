import type { GithubMirrorSource } from '@shared/development/github/types'

export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    if (url.username || url.password) return false
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeMirrorUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return url.href.replace(/\/+$/, '')
}

export function resolveMirror(
  mirrors: readonly GithubMirrorSource[],
  currentId: string | null | undefined,
): GithubMirrorSource | null {
  const enabled = mirrors.filter((mirror) => mirror.enabled)
  return enabled.find((mirror) => mirror.id === currentId) ?? enabled[0] ?? null
}
