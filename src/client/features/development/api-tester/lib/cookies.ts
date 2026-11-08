import { newApiTesterId } from '@shared/development/api-tester/ids'
import type { CookieRecord, ResponseResult } from '@shared/development/api-tester/types'

const MAX_COOKIES = 500

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\./, '')
}

/** RFC 6265 domain matching, with the leading dot treated as optional. */
function domainMatches(host: string, domain: string): boolean {
  if (!domain) return false
  return host === domain || host.endsWith(`.${domain}`)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!cookiePath || cookiePath === '/') return true
  if (!requestPath.startsWith(cookiePath)) return false
  return requestPath.length === cookiePath.length || cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

export function cookieMatches(cookie: CookieRecord, url: URL, now = Date.now()): boolean {
  if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) return false
  if (cookie.secure && url.protocol !== 'https:') return false
  return domainMatches(hostOf(url), cookie.domain) && pathMatches(url.pathname || '/', cookie.path)
}

/** The `Cookie` header value for a request, longest path first as browsers do. */
export function cookieHeaderFor(url: URL, cookies: readonly CookieRecord[], now = Date.now()): string {
  const matching = cookies
    .filter((cookie) => cookieMatches(cookie, url, now))
    .sort((left, right) => right.path.length - left.path.length)
  return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/** Applies a response's Set-Cookie list to the jar, keeping one row per name/domain/path. */
export function mergeResponseCookies(
  existing: readonly CookieRecord[],
  result: Pick<ResponseResult, 'cookies' | 'url'>,
  now = Date.now(),
): CookieRecord[] {
  if (!result.cookies || result.cookies.length === 0) return [...existing]
  let url: URL
  try {
    url = new URL(result.url)
  } catch {
    return [...existing]
  }
  const byId = new Map<string, CookieRecord>()
  for (const cookie of existing) {
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) continue
    byId.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, cookie)
  }
  for (const cookie of result.cookies) {
    const domain = (cookie.domain ?? hostOf(url)).replace(/^\./, '').toLowerCase()
    const path = cookie.path || '/'
    const key = `${cookie.name}\u0000${domain}\u0000${path}`
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      byId.delete(key)
      continue
    }
    const previous = byId.get(key)
    byId.set(key, {
      id: previous?.id ?? newApiTesterId(),
      name: cookie.name,
      value: cookie.value,
      domain,
      path,
      expiresAt: cookie.expiresAt,
      secure: cookie.secure === true ? true : undefined,
      httpOnly: cookie.httpOnly === true ? true : undefined,
    })
  }
  return [...byId.values()].slice(0, MAX_COOKIES)
}
