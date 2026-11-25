export function privateAttachmentId(value: string | null): string | null {
  if (!value || value.startsWith('blob:') || value.startsWith('data:')) return null
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin) return null
    const match = /^\/api\/files\/([0-9a-hjkmnp-tv-z]{26})$/.exec(url.pathname)
    return match?.[1] ?? null
  } catch {
    return null
  }
}
