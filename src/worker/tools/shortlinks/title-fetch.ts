/**
 * Title fetcher with SSRF prevention and timeout protection.
 */

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim()
  if (host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || host === '::1') return true

  // IPv4 checks
  const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])]
    if (a === 127) return true // 127.0.0.0/8 Loopback
    if (a === 10) return true // 10.0.0.0/8 Private
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 Private
    if (a === 192 && b === 168) return true // 192.168.0.0/16 Private
    if (a === 169 && b === 254) return true // 169.254.0.0/16 Link-local / Cloud metadata
    if (a === 0) return true
  }

  // IPv6 checks
  if (host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80')) return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true

  return false
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return null

  const raw = match[1]
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .trim()

  return raw ? raw.slice(0, 120) : null
}

export async function fetchPageTitle(url: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    if (isPrivateHost(parsed.hostname)) {
      return null
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Inkstone-LinkPreview/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null
    }

    const reader = res.body?.getReader()
    if (!reader) return null

    let html = ''
    const decoder = new TextDecoder()
    const maxBytes = 16384
    let totalBytes = 0

    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
      totalBytes += value.byteLength

      if (html.includes('</title>') || html.includes('</head>')) break
    }
    reader.cancel()

    return extractTitle(html)
  } catch {
    return null
  }
}
