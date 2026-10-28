export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function readHttpUrl(value: unknown, maxLength: number): string {
  return isHttpUrl(value) && value.length <= maxLength ? value : ''
}

export function readNullableHttpUrl(value: unknown, maxLength: number): string | null {
  return isHttpUrl(value) && value.length <= maxLength ? value : null
}
