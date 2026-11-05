/**
 * Cookie plumbing for the drivers that authenticate with a browser session.
 *
 * Workers expose `Set-Cookie` either through the standard `getSetCookie()` accessor or through the
 * legacy multi-value `getAll('set-cookie')`. Neither a Node `cookie` package nor a DOM are available
 * in the worker, so the small parser every session driver needs lives here once.
 */

export type CookieJar = Record<string, string>

/** Parses a `Cookie` request header or a pasted browser cookie string into name/value pairs. */
export function parseCookies(raw: string): CookieJar {
  const jar: CookieJar = {}
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    jar[name] = part.slice(index + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  return jar
}

export function cookieValue(raw: string, name: string): string {
  return parseCookies(raw)[name] ?? ''
}

/** Serializes a jar into a `Cookie` request header; a raw string is passed through untouched. */
export function cookieHeader(jar: CookieJar | string): string {
  if (typeof jar === 'string') return jar.trim()
  return Object.entries(jar)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** The `Set-Cookie` values of a response across both worker header APIs. */
export function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie()
    if (values.length > 0) return values
  }
  const joined = headers.get('set-cookie')
  if (!joined) return []
  // A merged header can only be split safely when the comma is followed by a cookie name. Most
  // upstream services send one header per cookie, and `getSetCookie` handles that case.
  return joined.split(/,(?=\s*[^;,=]+=)/).map((value) => value.trim()).filter(Boolean)
}

/** Applies every `Set-Cookie` name/value pair to the jar, ignoring attributes such as Path. */
export function mergeResponseCookies(jar: CookieJar, response: Response): CookieJar {
  for (const header of setCookieHeaders(response)) {
    const pair = header.split(';', 1)[0] ?? ''
    const index = pair.indexOf('=')
    if (index < 0) continue
    const name = pair.slice(0, index).trim()
    if (!name) continue
    jar[name] = pair.slice(index + 1).trim()
  }
  return jar
}

/** A bare Bearer token, a JWT, or a cookie jar that stores the token under a known name. */
export function tokenFromCookie(raw: string, names: readonly string[] = ['token', 'access_token', 'authorization']): string {
  const text = raw.trim()
  if (!text) return ''
  if (/^Bearer\s+/i.test(text)) return text.replace(/^Bearer\s+/i, '').trim()
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text
  const jar = parseCookies(text)
  for (const name of names) {
    const value = jar[name] ?? ''
    if (!value) continue
    return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, '').trim() : value
  }
  return ''
}
