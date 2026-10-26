/**
 * Title fetcher with SSRF prevention, safe redirect validation, and timeout protection.
 */

import { isBlockedTarget } from '@shared/ai-proxy-guard'

export function isPrivateHost(hostname: string): boolean {
  return isBlockedTarget(hostname)
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
    let currentUrl = url
    let res: Response | null = null
    const maxRedirects = 3

    for (let i = 0; i <= maxRedirects; i++) {
      let parsed: URL
      try {
        parsed = new URL(currentUrl)
      } catch {
        return null
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null
      }

      if (isBlockedTarget(parsed.hostname)) {
        return null
      }

      const response = await fetch(currentUrl, {
        headers: { 'User-Agent': 'Inkstone-LinkPreview/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return null
        currentUrl = new URL(location, currentUrl).href
        continue
      }

      res = response
      break
    }

    if (!res || !res.ok) return null

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
    void reader.cancel().catch(() => {
      // Best-effort cancel of stream reading
    })

    return extractTitle(html)
  } catch {
    // Non-fatal: title sniffing is best-effort and failures safely fallback to null
    return null
  }
}
