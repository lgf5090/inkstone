/**
 * CalDAV discovery, server-side.
 *
 * The password is typed by the reader but never leaves this worker: it signs the two PROPFIND calls
 * that find the principal and the calendar home, and that is the end of its life. Every address the
 * server hands back is checked again — same origin, or an Apple host when the server itself is Apple's —
 * because discovery is a redirect by another name, and a redirect that is followed without a check is
 * how a proxy ends up talking to a metadata endpoint.
 *
 * The XML reader is deliberately small: CalDAV answers are well-formed XML with a handful of known
 * elements, so namespace prefixes are normalized away and the first matching element is read. It is
 * not a general XML parser and never sees HTML.
 */
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { toBase64, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'

export const CALDAV_PRESETS = ['icloud', 'nextcloud', 'radicale', 'fastmail', 'custom'] as const
export type CaldavPreset = (typeof CALDAV_PRESETS)[number]

export const ICLOUD_CALDAV_SERVER = 'https://caldav.icloud.com/'

const DISCOVERY_TIMEOUT_MS = 10_000
const MAX_DISCOVERY_BYTES = 64 * 1024
const MAX_URL_LENGTH = 2048
const MAX_USERNAME_LENGTH = 256
const MAX_PASSWORD_LENGTH = 4096

const CURRENT_USER_PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`

const CALENDAR_HOME_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`

export interface ResolvedPreset {
  preset: CaldavPreset
  serverUrl: URL
  /** Null means the home has to be discovered; a preset that already knows its shape fills it in. */
  calendarHomeUrl: string | null
  username: string
  label: string
}

export interface CalendarDiscoveryResult {
  calendarHomeUrl: string
  username: string
  /** Null when the server did not say; false only when it explicitly listed no write privilege. */
  canWrite: boolean | null
}

export interface CalendarPrivileges {
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}

export interface CalendarConnectionDiscoveryInput {
  preset: CaldavPreset
  serverUrl: string
  username: unknown
  password: unknown
  writable: boolean
}

export interface CalendarConnectionDiscovery {
  baseUrl: string
  calendarHomeUrl: string
  username: string
  writable: boolean
  label: string
}

export function isCaldavPreset(value: unknown): value is CaldavPreset {
  return typeof value === 'string' && (CALDAV_PRESETS as readonly string[]).includes(value)
}

/**
 * The one URL rule for every outbound CalDAV address.
 *
 * https only, no userinfo, no fragment or query (a collection address with either is not one), the
 * standard port, and a host the shared guard does not call private. The same function checks the
 * discovery input and every address discovery returns.
 */
export function validateConnectionUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw ApiError.badRequest('A calendar server address is required')
  const value = raw.trim()
  if (!value || value.length > MAX_URL_LENGTH) throw ApiError.badRequest('The calendar server address is not valid')
  if (/[\u0000-\u001f\u007f]/.test(value)) throw ApiError.badRequest('The calendar server address is not valid')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ApiError.badRequest('The calendar server address is not valid')
  }
  if (url.protocol !== 'https:') throw ApiError.badRequest('Calendar servers are reached over https only')
  if (url.username || url.password) throw ApiError.badRequest('A calendar server address may not carry credentials')
  if (url.port && url.port !== '443') throw ApiError.badRequest('Calendar servers are reached on port 443 only')
  if (url.hash || url.search) throw ApiError.badRequest('A calendar server address may not carry a query or fragment')
  if (!url.hostname || isBlockedTarget(url.hostname)) {
    throw ApiError.badRequest('That calendar server address is not reachable from this deployment')
  }
  return url
}

export function validateCalendarUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw ApiError.badRequest('A calendar username is required')
  const username = raw.trim()
  if (!username || username.length > MAX_USERNAME_LENGTH) {
    throw ApiError.badRequest('The calendar username is not valid')
  }
  // A colon is the separator Basic auth uses; a newline could smuggle a second header.
  if (/[\u0000-\u001f\u007f:]/.test(username)) throw ApiError.badRequest('The calendar username is not valid')
  return username
}

export function validateCalendarPassword(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PASSWORD_LENGTH) {
    throw ApiError.badRequest('A calendar password or app password is required')
  }
  if (/[\r\n\0]/.test(raw)) throw ApiError.badRequest('The calendar password is not valid')
  return raw
}

/**
 * Where a preset says the calendar home is.
 *
 * iCloud has one server for everybody and has to be discovered. The other three presets have a
 * documented shape, which is why creating one of those connections costs no network request at all.
 * `custom` also has to discover, because only the server knows.
 */
export function resolvePreset(
  preset: CaldavPreset,
  rawServerUrl: unknown,
  rawUsername: unknown,
): ResolvedPreset {
  const username = validateCalendarUsername(rawUsername)
  if (preset === 'icloud') {
    const serverUrl = validateConnectionUrl(ICLOUD_CALDAV_SERVER)
    return { preset, serverUrl, calendarHomeUrl: null, username, label: 'iCloud' }
  }
  const serverUrl = validateConnectionUrl(rawServerUrl)
  const basePath = serverUrl.pathname.replace(/\/+$/, '')
  const user = encodeURIComponent(username)
  if (preset === 'nextcloud') {
    return {
      preset,
      serverUrl,
      calendarHomeUrl: validateConnectionUrl(`${serverUrl.origin}${basePath}/remote.php/dav/calendars/${user}/`).toString(),
      username,
      label: 'Nextcloud',
    }
  }
  if (preset === 'radicale') {
    return {
      preset,
      serverUrl,
      calendarHomeUrl: validateConnectionUrl(`${serverUrl.origin}${basePath}/${user}/`).toString(),
      username,
      label: 'Radicale',
    }
  }
  if (preset === 'fastmail') {
    return {
      preset,
      serverUrl,
      calendarHomeUrl: validateConnectionUrl(`${serverUrl.origin}/dav/principals/user/${user}/`).toString(),
      username,
      label: 'Fastmail',
    }
  }
  return { preset, serverUrl, calendarHomeUrl: null, username, label: serverUrl.hostname }
}

/** Run the preset resolution and, when it left the home unknown, the two PROPFIND calls. */
export async function discoverCalendarConnection(
  input: CalendarConnectionDiscoveryInput,
): Promise<CalendarConnectionDiscovery> {
  if (!isCaldavPreset(input.preset)) throw ApiError.badRequest('Unknown calendar preset')
  const preset = resolvePreset(input.preset, input.serverUrl, input.username)
  const password = validateCalendarPassword(input.password)
  let canWrite: boolean | null = null
  let calendarHomeUrl = preset.calendarHomeUrl
  if (!calendarHomeUrl) {
    const discovered = await discoverCalendarHome(preset.serverUrl, preset.username, password)
    calendarHomeUrl = discovered.calendarHomeUrl
    canWrite = discovered.canWrite
  }
  return {
    baseUrl: canonicalBaseUrl(preset.serverUrl),
    calendarHomeUrl,
    username: preset.username,
    // A server that explicitly listed no write privilege wins over the reader's preference; silence
    // (Radicale omits the property) does not, because it is not a refusal.
    writable: input.writable && canWrite !== false,
    label: preset.label,
  }
}

/**
 * The two-step RFC 4791 / RFC 5397 discovery: principal, then calendar home.
 *
 * Both calls are Depth 1 PROPFINDs with Basic auth. A redirect is refused rather than followed, the
 * body is capped while it streams, and the address each response names is checked against the server
 * the reader typed before it becomes either the next request or the stored home.
 */
export async function discoverCalendarHome(
  serverUrl: URL,
  username: string,
  password: string,
): Promise<CalendarDiscoveryResult> {
  const authorization = `Basic ${toBase64(utf8(`${username}:${password}`))}`
  const principalXml = await propfind(serverUrl, CURRENT_USER_PRINCIPAL_BODY, authorization)
  const principalHref = extractFirstHref(principalXml, 'current-user-principal')
  if (!principalHref) {
    throw new ApiError(502, 'internal', 'The calendar server did not say which principal to use')
  }
  const principalUrl = resolveHref(serverUrl, principalHref)
  assertAllowedDiscoveryUrl(principalUrl, serverUrl)

  const homeXml = await propfind(principalUrl, CALENDAR_HOME_BODY, authorization)
  const homeHref = extractFirstHref(homeXml, 'calendar-home-set')
  if (!homeHref) {
    throw new ApiError(502, 'internal', 'The calendar server did not say where the calendars live')
  }
  const homeUrl = resolveHref(principalUrl, homeHref)
  assertAllowedDiscoveryUrl(homeUrl, serverUrl)
  return {
    calendarHomeUrl: collectionUrl(homeUrl),
    username,
    canWrite: writeAllowed(parseCalendarPrivileges(homeXml)),
  }
}

async function propfind(url: URL, body: string, authorization: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: 'PROPFIND',
      headers: {
        authorization,
        depth: '1',
        'content-type': 'application/xml; charset=utf-8',
        accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
      },
      body,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError(502, 'internal', 'The calendar server did not answer discovery in time')
    }
    throw new ApiError(502, 'internal', 'The calendar server could not be reached for discovery')
  }
  if (isRedirectResponse(response)) {
    throw new ApiError(502, 'internal', 'The calendar server redirected discovery, which is not followed')
  }
  if (!response.ok) {
    throw new ApiError(502, 'internal', `The calendar server refused discovery (${response.status})`)
  }
  const xml = await readStreamTextWithinLimit(response.body, MAX_DISCOVERY_BYTES)
  if (xml === null) {
    throw new ApiError(502, 'internal', 'The calendar server answered discovery with too much data')
  }
  return xml
}

/**
 * Same origin, or Apple's own addresses for Apple's own server.
 *
 * iCloud answers `caldav.icloud.com` with a shard under a different subdomain; that is still Apple,
 * so the suffix is the one exception. Every other host change is a discovery response pointing the
 * worker at a site the reader never named, and it is refused.
 */
function assertAllowedDiscoveryUrl(target: URL, serverUrl: URL): void {
  const checked = validateConnectionUrl(target.toString())
  if (checked.origin === serverUrl.origin) return
  const appleServer = serverUrl.hostname === 'icloud.com' || serverUrl.hostname.endsWith('.icloud.com')
  const appleTarget = checked.hostname === 'icloud.com' || checked.hostname.endsWith('.icloud.com')
  if (appleServer && appleTarget) return
  throw new ApiError(502, 'internal', 'The calendar server pointed discovery at an address this deployment will not follow')
}

function canonicalBaseUrl(serverUrl: URL): string {
  const path = serverUrl.pathname.endsWith('/') ? serverUrl.pathname : `${serverUrl.pathname}/`
  return `${serverUrl.origin}${path}`
}

function collectionUrl(url: URL): string {
  return url.pathname.endsWith('/') ? url.toString() : `${url.toString()}/`
}

function resolveHref(base: URL, href: string): URL {
  const collectionBase = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`
  return new URL(href, collectionBase)
}

function writeAllowed(privileges: CalendarPrivileges | null): boolean | null {
  if (!privileges) return null
  return privileges.canCreate || privileges.canUpdate || privileges.canDelete
}

// ---------------------------------------------------------------------------- XML

/**
 * Remove namespace prefixes and declarations so one regex can match whichever prefix a server chose.
 * Comments and processing instructions go too; neither carries discovery state.
 */
export function normalizeXml(xml: string): string {
  return xml
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/<\?[\s\S]*?\?>/g, '')
    .replaceAll(/\s+xmlns(?::\w+)?\s*=\s*("[^"]*"|'[^']*')/g, '')
    .replaceAll(/<(\/?)\w+:([\w-]+)/g, '<$1$2')
}

/** Text content of the first matching element, with the five XML entities and numeric ones decoded. */
export function extractFirstText(xml: string, tag: string): string | null {
  const normalized = normalizeXml(xml)
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = normalized.match(new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`, 'i'))
  return match ? decodeXmlText(match[1]!.trim()) : null
}

/** The first `<href>` inside the named element, which is how every CalDAV property carries a URL. */
export function extractFirstHref(xml: string, tag: string): string | null {
  const inner = extractFirstText(xml, tag)
  if (!inner) return null
  const match = inner.match(/<href(?:\s[^>]*)?>([\s\S]*?)<\/href>/i)
  return match ? match[1]!.trim() : null
}

/** `current-user-privilege-set`, or null when the server omitted it (Radicale does). */
export function parseCalendarPrivileges(xml: string): CalendarPrivileges | null {
  const inner = extractFirstText(xml, 'current-user-privilege-set')
  if (!inner) return null
  const has = (name: string) => new RegExp(`<${name}(?:[\\s/>]|>)`).test(inner)
  const write = has('write') || has('write-content')
  return {
    canCreate: has('bind') || write,
    canUpdate: write,
    canDelete: has('unbind') || write,
  }
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, decimal: string) => codePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function codePoint(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : '\ufffd'
}
