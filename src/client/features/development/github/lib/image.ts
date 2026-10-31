export function proxiedImageUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('/api/development/github/image?')) return trimmed
  if (/^data:/i.test(trimmed)) return trimmed
  return `/api/development/github/image?url=${encodeURIComponent(trimmed)}`
}
