/**
 * CalDAV discovery, server-side.
 *
 * The password is typed by the reader but never leaves this worker: it signs the two PROPFIND calls
 * that find the principal and the calendar home, and that is the end of its life. Every address the
 * server hands back is checked again — same origin, or an Apple host when the server itself is Apple's —
 * because discovery is a redirect by another name, and a redirect that is followed without a check is
 * how a proxy ends up talking to a metadata endpoint.
 *
 * CalDAV answers are parsed as XML, not searched as text. The parser resolves namespace URIs so a
 * server may choose any prefix (or a default namespace) without letting an unrelated namespace impersonate
 * a DAV property. DTDs are refused because discovery has no legitimate use for entity declarations.
 */
import { Parser } from 'htmlparser2'
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

const DAV_NAMESPACE = 'DAV:'
const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav'
const XML_ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

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
  </D:prop>
</D:propfind>`

const CALENDAR_HOME_VERIFICATION_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
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
}

export interface CalendarPrivileges {
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}

export interface CalendarConnectionDiscoveryInput {
  preset: CaldavPreset
  serverUrl: unknown
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
  // `localhost.` is the same host as `localhost` to a resolver; the guard is asked about the name
  // without the root dot so the suffix table cannot be sidestepped by spelling.
  const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
  if (!hostname || isBlockedTarget(hostname)) {
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
  // A colon is the separator Basic auth uses; a newline could smuggle a second header. A username
  // that is exactly `.` or `..` would be normalized away by the preset's URL builder.
  if (/[\u0000-\u001f\u007f:]/.test(username) || username === '.' || username === '..') {
    throw ApiError.badRequest('The calendar username is not valid')
  }
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
  let calendarHomeUrl = preset.calendarHomeUrl
  if (!calendarHomeUrl) {
    const discovered = await discoverCalendarHome(preset.serverUrl, preset.username, password)
    calendarHomeUrl = discovered.calendarHomeUrl
  } else {
    const authorization = `Basic ${toBase64(utf8(`${preset.username}:${password}`))}`
    const xml = await propfind(new URL(calendarHomeUrl), CALENDAR_HOME_VERIFICATION_BODY, authorization)
    if (!hasXmlElement(xml, 'resourcetype')) {
      throw new ApiError(502, 'internal', 'The calendar server did not confirm a CalDAV calendar home')
    }
  }
  return {
    baseUrl: canonicalBaseUrl(preset.serverUrl),
    calendarHomeUrl,
    username: preset.username,
    writable: input.writable,
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
  const homeHref = extractFirstHref(homeXml, 'calendar-home-set', CALDAV_NAMESPACE)
  if (!homeHref) {
    throw new ApiError(502, 'internal', 'The calendar server did not say where the calendars live')
  }
  const homeUrl = resolveHref(principalUrl, homeHref)
  assertAllowedDiscoveryUrl(homeUrl, serverUrl)
  return { calendarHomeUrl: collectionUrl(homeUrl), username }
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
  if (response.status !== 207) {
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


// ---------------------------------------------------------------------------- XML

interface DiscoveryElement {
  name: string
  namespace: string
  children: DiscoveryElement[]
  text: string
}

interface OpenElement {
  node: DiscoveryElement
  namespaces: ReadonlyMap<string, string>
  qualifiedName: string
  selfClosing: boolean
}

function openingTag(xml: string, start: number): { end: number; selfClosing: boolean } {
  let quote = ''
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index]!
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return { end: index, selfClosing: xml.slice(start + 1, index).trimEnd().endsWith('/') }
    }
  }
  throw new Error('Unclosed XML tag')
}

function qualifiedName(name: string): { prefix: string; local: string } {
  const parts = name.split(':')
  if (parts.length > 2 || parts.some(part => !XML_ELEMENT_NAME.test(part))) throw new Error('Invalid XML name')
  return parts.length === 2 ? { prefix: parts[0]!, local: parts[1]! } : { prefix: '', local: name }
}

/** Parse one bounded CalDAV XML response, rejecting malformed documents and every DTD. */
function parseDiscoveryXml(xml: string): DiscoveryElement {
  try {
    const rootBox: { current: DiscoveryElement | null } = { current: null }
    const stack: OpenElement[] = []
    const parser = new Parser({
      onopentag(name, attributes) {
        if (stack.length === 0 && rootBox.current) throw new Error('Multiple XML roots')
        const namespaces = new Map(stack.at(-1)?.namespaces ?? [])
        for (const [attribute, value] of Object.entries(attributes)) {
          if (attribute === 'xmlns') namespaces.set('', value)
          else if (attribute.startsWith('xmlns:')) {
            const prefix = attribute.slice('xmlns:'.length)
            if (!XML_ELEMENT_NAME.test(prefix) || !value) throw new Error('Invalid namespace declaration')
            namespaces.set(prefix, value)
          }
        }
        const qualified = qualifiedName(name)
        const namespace = (qualified.prefix ? namespaces.get(qualified.prefix) : namespaces.get('')) ?? ''
        if (qualified.prefix && !namespace) throw new Error('Undeclared XML namespace')
        const node: DiscoveryElement = { name: qualified.local, namespace, children: [], text: '' }
        if (stack.at(-1)) stack.at(-1)!.node.children.push(node)
        else rootBox.current = node
        const tag = openingTag(xml, parser.startIndex)
        stack.push({ node, namespaces, qualifiedName: name, selfClosing: tag.selfClosing })
      },
      onclosetag(name, implied) {
        const open = stack.at(-1)
        if (!open) throw new Error('Unexpected XML close tag')
        if (open.selfClosing && implied) {
          stack.pop()
          return
        }
        if (implied || open.qualifiedName !== name) throw new Error('Mismatched XML close tag')
        stack.pop()
      },
      ontext(value) {
        if (!stack.length) {
          if (value.trim()) throw new Error('Text outside the XML root')
          return
        }
        stack.at(-1)!.node.text += value
      },
      onprocessinginstruction(name) {
        if (name.toLowerCase() === '!doctype') throw new Error('DTD is not allowed')
      },
      onerror(error) {
        throw error
      },
    }, { xmlMode: true, decodeEntities: true })
    parser.write(xml)
    parser.end()
    const root = rootBox.current
    if (stack.length > 0 || !root) throw new Error('Incomplete XML document')
    if (root.namespace !== DAV_NAMESPACE || root.name !== 'multistatus') {
      throw new Error('Expected a DAV multistatus document')
    }
    return root
  } catch (error) {
    console.warn('[inkstone] CalDAV discovery XML rejected:', error instanceof Error ? error.message : error)
    throw new ApiError(502, 'internal', 'The calendar server returned malformed discovery XML')
  }
}

function descendants(element: DiscoveryElement): DiscoveryElement[] {
  return element.children.flatMap(child => [child, ...descendants(child)])
}

function firstElement(element: DiscoveryElement, tag: string, namespace = DAV_NAMESPACE): DiscoveryElement | null {
  return descendants(element).find(candidate => candidate.name === tag && candidate.namespace === namespace) ?? null
}

function elementText(element: DiscoveryElement): string {
  return element.text + element.children.map(elementText).join('')
}

function hasXmlElement(xml: string, tag: string, namespace = DAV_NAMESPACE): boolean {
  if (!XML_ELEMENT_NAME.test(tag)) throw new Error('Invalid XML element name')
  return firstElement(parseDiscoveryXml(xml), tag, namespace) !== null
}

/** Text content of the first element in the expected namespace, decoded by the XML parser. */
export function extractFirstText(
  xml: string,
  tag: string,
  namespace = DAV_NAMESPACE,
): string | null {
  if (!XML_ELEMENT_NAME.test(tag)) throw new Error('Invalid XML element name')
  const element = firstElement(parseDiscoveryXml(xml), tag, namespace)
  return element ? elementText(element).trim() : null
}

/** The first DAV `<href>` inside the named property, resolved by namespace rather than prefix. */
export function extractFirstHref(
  xml: string,
  tag: string,
  namespace = DAV_NAMESPACE,
): string | null {
  if (!XML_ELEMENT_NAME.test(tag)) throw new Error('Invalid XML element name')
  const property = firstElement(parseDiscoveryXml(xml), tag, namespace)
  const href = property ? firstElement(property, 'href') : null
  return href ? elementText(href).trim() || null : null
}

/** `current-user-privilege-set`, or null when the server omitted it (Radicale does). */
export function parseCalendarPrivileges(xml: string): CalendarPrivileges | null {
  const property = firstElement(parseDiscoveryXml(xml), 'current-user-privilege-set')
  if (!property) return null
  const privileges = new Set<string>()
  for (const privilege of descendants(property).filter(element => element.name === 'privilege' && element.namespace === DAV_NAMESPACE)) {
    for (const child of privilege.children) {
      if (child.namespace === DAV_NAMESPACE) privileges.add(child.name)
    }
  }
  const write = privileges.has('write') || privileges.has('write-content')
  return {
    canCreate: privileges.has('bind') || write,
    canUpdate: write,
    canDelete: privileges.has('unbind') || write,
  }
}
