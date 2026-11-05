/**
 * AutoIndex driver — a read-only adapter for Nginx/Apache style directory listings.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/autoindex`. The reference used an XPath engine
 * on a DOM; Workers have neither, so this keeps the same semantics with a small HTML scan:
 * `itemXpath` either names the common `//pre/a` / `//a` templates or is treated as a regular
 * expression whose first three groups are `href`, `name text` and the trailing metadata text.
 * Size and modified time are read from the text following the anchor, which covers both the
 * Apache (`date size`) and the Nginx (`size date`) orders.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const DEFAULT_ITEM_XPATH = '//pre/a'
const DEFAULT_NAME_XPATH = '@href'
const DEFAULT_SIZE_XPATH = 'string(following-sibling::text()[1])'
const DEFAULT_MODIFIED_XPATH = 'string(following-sibling::text()[2])'
const FETCH_TIMEOUT_MS = 30_000

const SIZE_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1 << 10,
  kb: 1 << 10,
  kib: 1 << 10,
  m: 1 << 20,
  mb: 1 << 20,
  mib: 1 << 20,
  g: 1 << 30,
  gb: 1 << 30,
  gib: 1 << 30,
  t: 1 << 40,
  tb: 1 << 40,
  tib: 1 << 40,
  p: 1 << 50,
  pb: 1 << 50,
  pib: 1 << 50,
}

interface Anchor {
  href: string
  text: string
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** A small, dependency-free HTML scan; the built-in templates cover Apache and Nginx indexes. */
function anchorsOf(html: string, itemXpath: string): Anchor[] {
  const custom = itemXpath.trim()
  const scoped = !custom || custom.startsWith('//')
  let source = html
  if (scoped) {
    const start = html.search(/<pre\b/i)
    if (start >= 0) {
      const end = html.slice(start).search(/<\/pre>/i)
      if (end >= 0) source = html.slice(start, start + end)
    }
  }
  const pattern = scoped || !custom
    ? /<a\s+[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi
    : (() => {
      try {
        return new RegExp(custom, 'gi')
      } catch {
        throw DriverError.invalid(`AutoIndex itemXpath is not a valid pattern: ${custom}`)
      }
    })()
  const matches = Array.from(source.matchAll(pattern))
  return matches.map((match) => {
    const href = match[1] ?? match[2] ?? ''
    const text = stripTags(match[3] ?? '')
    return { href, text }
  })
}

/** The text after each anchor up to the next anchor, which holds the size/date columns. */
function trailingTexts(html: string, itemXpath: string): string[] {
  const scoped = !itemXpath.trim() || itemXpath.trim().startsWith('//')
  if (!scoped) return []
  let source = html
  const start = html.search(/<pre\b/i)
  if (start >= 0) {
    const end = html.slice(start).search(/<\/pre>/i)
    if (end >= 0) source = html.slice(start, start + end)
  }
  const pattern = /<a\s+[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi
  const matches = Array.from(source.matchAll(pattern))
  return matches.map((match, index) => {
    const after = match.index === undefined ? 0 : match.index + match[0].length
    const next = matches[index + 1]?.index ?? source.length
    return stripTags(source.slice(after, next))
  })
}

function splitUnit(value: string): [string, string] {
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value[index]!
    if (char >= '0' && char <= '9') {
      return [value.slice(0, index + 1).trim(), value.slice(index + 1).trim()]
    }
  }
  return ['', value]
}

export function parseAutoIndexSize(raw: string): number {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return 0
  const [number, unit] = splitUnit(raw.trim())
  const multiplier = SIZE_UNITS[unit.toLowerCase()] ?? 1
  const parsed = Number.parseFloat(number)
  return Number.isNaN(parsed) ? 0 : Math.round(parsed * multiplier)
}

function textIndex(xpath: string): number | null {
  const match = /text\(\)\s*\[\s*(\d+)\s*\]/.exec(xpath)
  if (!match) return null
  const index = Number(match[1]) - 1
  return Number.isInteger(index) && index >= 0 ? index : null
}

function looksLikeDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(text)
    || /^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(text)
    || /^[A-Za-z]{3},\s+\d{1,2}\s+\d{4}/.test(text)
    || /^\d{2}:\d{2}(?::\d{2})?/.test(text)
}

function metadataOf(
  trailing: string,
  sizeIndex: number | null,
  modifiedIndex: number | null,
): { size: number; modifiedAt: number } {
  const tokens = trailing.replace(/[|·]/g, ' ').split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { size: 0, modifiedAt: 0 }
  if (sizeIndex !== null || modifiedIndex !== null) {
    const size = sizeIndex !== null ? parseAutoIndexSize(tokens[sizeIndex] ?? '') : 0
    const modified = modifiedIndex !== null ? tokens[modifiedIndex] ?? '' : ''
    return { size, modifiedAt: Date.parse(modified) || 0 }
  }
  let sizeText = ''
  let dateText = ''
  for (let index = 0; index < tokens.length; index++) {
    const single = tokens[index]!
    const pair = tokens[index + 1] ? `${single} ${tokens[index + 1]}` : single
    if (looksLikeDate(pair)) {
      dateText = pair
      index++
      continue
    }
    if (looksLikeDate(single)) {
      dateText = single
      continue
    }
    if (!sizeText && /^(?:\d+(?:\.\d+)?(?:[KMGTPE]i?B?|B)?|-)$/i.test(single)) sizeText = single
  }
  return {
    size: parseAutoIndexSize(sizeText),
    modifiedAt: dateText ? Date.parse(dateText) || 0 : 0,
  }
}

function nameFromHref(href: string, base: string): string {
  try {
    const url = new URL(href, base)
    const segments = url.pathname.split('/').filter(Boolean)
    return decodeURIComponent(segments[segments.length - 1] ?? '')
  } catch {
    const path = href.split(/[?#]/)[0] ?? ''
    const segments = path.replace(/\/+$/, '').split('/').filter(Boolean)
    return decodeURIComponent(segments[segments.length - 1] ?? '')
  }
}

class AutoIndexDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('autoindex')!
  readonly capabilities = this.definition.capabilities

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    this.baseUrl()
  }

  private baseUrl(): string {
    let url = this.configText('url').trim()
    if (!url) throw DriverError.auth('AutoIndex needs the directory URL.')
    if (!/:\/\//.test(url)) url = `https://${url}`
    try {
      new URL(url)
    } catch {
      throw DriverError.invalid(`AutoIndex URL is invalid: ${url}`)
    }
    return url.endsWith('/') ? url : `${url}/`
  }

  private rootRelative(): string {
    const root = driverPath(this.configText('rootPath', '/'))
    return root === '/' ? '' : `${root.slice(1)}/`
  }

  private directoryUrl(path: string): string {
    const clean = driverPath(path)
    const relative = clean === '/' ? '' : `${clean.slice(1)}/`
    return `${this.baseUrl()}${this.rootRelative()}${relative}`
  }

  private fileUrl(path: string): string {
    const clean = driverPath(path)
    return `${this.baseUrl()}${this.rootRelative()}${clean === '/' ? '' : clean.slice(1)}`
  }

  private parse(html: string, base: string): DriverEntry[] {
    const itemXpath = this.configText('itemXpath', DEFAULT_ITEM_XPATH) || DEFAULT_ITEM_XPATH
    const nameXpath = this.configText('nameXpath', DEFAULT_NAME_XPATH) || DEFAULT_NAME_XPATH
    // The reference defaults are text()[1]/text()[2]; real indexes put the date first on Apache
    // and the size first on Nginx, so the defaults fall back to the order-aware scan below.
    const sizeXpath = this.configText('sizeXpath', DEFAULT_SIZE_XPATH)
    const modifiedXpath = this.configText('modifiedXpath', DEFAULT_MODIFIED_XPATH)
    const sizeIndex = sizeXpath === DEFAULT_SIZE_XPATH ? null : textIndex(sizeXpath)
    const modifiedIndex = modifiedXpath === DEFAULT_MODIFIED_XPATH ? null : textIndex(modifiedXpath)
    const anchors = anchorsOf(html, itemXpath)
    const trailing = trailingTexts(html, itemXpath)
    const entries: DriverEntry[] = []
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index]!
      const href = anchor.href.trim()
      if (!href || href === '?' || href.startsWith('#') || /^(?:mailto|javascript):/i.test(href)) continue
      const nameFromLink = nameFromHref(href, base)
      const name = decodeEntities((nameXpath === '@href' ? nameFromLink : anchor.text || nameFromLink)).trim()
      const folder = href.replace(/[?#].*$/, '').endsWith('/') || anchor.text.trim().endsWith('/')
      const trimmed = name.replace(/\/+$/, '').trim()
      if (!trimmed || trimmed === '.' || trimmed === '..') continue
      if (/^parent directory$/i.test(trimmed)) continue
      if (trimmed.includes('/')) continue
      let url: string
      try {
        url = new URL(href, base).toString()
      } catch {
        continue
      }
      const meta = metadataOf(trailing[index] ?? '', sizeIndex, modifiedIndex)
      entries.push({
        name: trimmed,
        kind: folder ? 'folder' : 'file',
        size: folder ? 0 : meta.size,
        modifiedAt: meta.modifiedAt,
        ref: url,
        mime: folder ? 'application/octet-stream' : driverEntryMime(trimmed),
      })
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }

  private async fetchListing(path: string): Promise<DriverEntry[]> {
    const target = this.directoryUrl(path)
    const response = await this.request(target, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      retries: 0,
      redirect: 'follow',
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    const html = await response.text()
    return this.parse(html, target)
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return { entries: await this.fetchListing(clean), cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        name: 'root',
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: this.directoryUrl(clean),
      }
    }
    const name = driverFileName(clean)
    const siblings = await this.fetchListing(driverParentPath(clean))
    const hit = siblings.find((entry) => entry.name === name)
    if (hit) return hit
    // An empty directory is absent from its parent's anchor list but still lists successfully.
    try {
      await this.fetchListing(clean)
      return {
        name,
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: this.directoryUrl(clean),
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') {
        throw DriverError.notFound(`AutoIndex has no entry at ${clean}`)
      }
      throw error
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const target = this.fileUrl(clean)
    return await this.request(target, {
      headers: range ? { Range: range } : undefined,
      retries: 0,
      redirect: 'follow',
      timeoutMs: FETCH_TIMEOUT_MS,
    })
  }

  async upload(): Promise<void> {
    throw DriverError.unsupported('AutoIndex is read-only')
  }

  async mkdir(): Promise<void> {
    throw DriverError.unsupported('AutoIndex is read-only')
  }

  async rename(): Promise<void> {
    throw DriverError.unsupported('AutoIndex is read-only')
  }

  async move(): Promise<void> {
    throw DriverError.unsupported('AutoIndex is read-only')
  }

  async remove(): Promise<void> {
    throw DriverError.unsupported('AutoIndex is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const entries = await this.fetchListing('/')
      return { ok: true, message: `AutoIndex is reachable · ${entries.length} entries at the root` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'AutoIndex is unavailable' }
    }
  }
}

export function createAutoIndexDriver(ctx: DriverContext): MountDriver {
  return new AutoIndexDriver(ctx)
}
