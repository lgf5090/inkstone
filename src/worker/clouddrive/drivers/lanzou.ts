/**
 * Lanzou cloud drive driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/lanzou`: the personal-disk `doupload.php` task
 * protocol, the share-page HTML/JS scraping (`filemoreajax.php`, `ajaxfile.php`, the `/fn?` iframe),
 * and the Alibaba WAF `acw_sc__v2` challenge solver all follow it.
 *
 * The WAF cookie is domain scoped, so it is kept per host and replayed; the personal cookie is
 * merged from every `Set-Cookie` and written back through the vault. Lanzou has no upload API a
 * Worker can use, so `upload` is explicitly unsupported.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import {
  cookieHeader,
  mergeResponseCookies,
  parseCookies,
  type CookieJar,
} from './cookies'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const DEFAULT_BASE_URL = 'https://pc.woozooo.com'
const DEFAULT_SHARE_URL = 'https://pan.lanzoui.com'
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SHARE_DOMAINS = ['pan.lanzoui.com', 'lanzouw.com', 'lanzoux.com', 'lanzouy.com', 'lanzou.com'] as const
const COOKIE_EXPIRED_MSG =
  'The Lanzou cookie is expired or invalid. Paste a fresh browser cookie (it lasts about 15 days).'
const MAX_SHARE_PAGES = 50

interface LanzouItem {
  id: string
  name: string
  isFolder: boolean
  size: number
  modifiedAt: number
  url?: string
  pwd?: string
}

interface LanzouRawItem {
  name?: string
  name_all?: string
  id?: string
  fol_id?: string
  size?: string | number
  time?: string
  is_folder?: boolean
  url?: string
  pwd?: string
}

interface LanzouShareLink {
  url: string
  name: string
  size: number
  modifiedAt: number
}

/** The Alibaba WAF acw_sc__v2 solver, identical to the reference helper. */
function unbox(hexString: string): string {
  const box = [
    6, 28, 34, 31, 33, 18, 30, 23, 9, 8, 19, 38, 17, 24, 0, 5, 32, 21, 10, 22,
    25, 14, 15, 3, 16, 27, 13, 35, 2, 29, 11, 26, 4, 36, 1, 39, 37, 7, 20, 12,
  ]
  const created: string[] = new Array(hexString.length).fill('')
  for (let index = 0; index < box.length; index++) {
    const target = box[index]!
    if (target < created.length && index < hexString.length) created[target] = hexString[index]!
  }
  return created.join('')
}

function hexXor(left: string, right: string): string {
  const length = Math.min(left.length, right.length)
  const byteLength = Math.floor(length / 2)
  let result = ''
  for (let index = 0; index < byteLength; index++) {
    const a = parseInt(left.slice(index * 2, index * 2 + 2), 16)
    const b = parseInt(right.slice(index * 2, index * 2 + 2), 16)
    result += (a ^ b).toString(16).padStart(2, '0')
  }
  return result
}

function calcAcwScV2(html: string): string {
  const match = html.match(/arg1='([0-9A-Z]+)'/i)
  if (!match?.[1]) throw DriverError.upstream('Lanzou returned a WAF challenge without an arg1 value')
  return hexXor(unbox(match[1]), '3000176000856006061501533003690027800375')
}

function removeNotes(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|[^:]\/\/.*|\/\*[\s\S]*?\*\//g, (block) => {
    if (block.slice(1, 3) === '//') return block.slice(0, 1)
    return '\n'
  })
}

function removeJSComment(data: string): string {
  let result = ''
  let inComment = false
  let inSingleLine = false
  for (let index = 0; index < data.length; index++) {
    const value = data[index]!
    if (inSingleLine && (value === '\n' || value === '\r')) {
      inSingleLine = false
      result += value
      continue
    }
    if (inComment && value === '*' && index + 1 < data.length && data[index + 1] === '/') {
      inComment = false
      index++
      continue
    }
    if (inComment || inSingleLine) continue
    if (value === '/' && index + 1 < data.length) {
      const next = data[index + 1]
      if (next === '*') {
        inComment = true
        index++
        continue
      }
      if (next === '/') {
        inSingleLine = true
        index++
        continue
      }
    }
    result += value
  }
  return result
}

/** Lanzou shows a relative timestamp (`3 days ago`, `yesterday`) or an absolute date. */
function parseLanzouTime(raw: string | undefined): number {
  if (!raw) return 0
  const text = raw.trim()
  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime())) return direct.getTime()
  const match = text.match(/([0-9.]*)\s*([\u4e00-\u9fa5]+)/)
  if (!match) return 0
  const value = Number.parseFloat(match[1] ?? '0') || 0
  const unit = match[2] ?? ''
  const now = Date.now()
  if (unit.includes('\u79d2\u524d')) return now - value * 1000
  if (unit.includes('\u5206')) return now - value * 60_000
  if (unit.includes('\u5c0f\u65f6')) return now - value * 3_600_000
  if (unit.includes('\u5929')) return now - value * 86_400_000
  if (unit.includes('\u6628\u5929')) return now - 86_400_000
  if (unit.includes('\u524d\u5929')) return now - 2 * 86_400_000
  return 0
}

/** `12.5 M`, `500 K`, `1024 B` → bytes. */
function parseLanzouSize(raw: string | number | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw) : 0
  if (!raw) return 0
  const match = raw.trim().match(/([0-9.]+)\s*([bkmg])/i)
  if (!match) return 0
  const value = Number.parseFloat(match[1] ?? '0') || 0
  const unit = (match[2] ?? 'b').toUpperCase()
  if (unit === 'B') return Math.floor(value)
  if (unit === 'K') return Math.floor(value * 1024)
  if (unit === 'M') return Math.floor(value * 1024 * 1024)
  if (unit === 'G') return Math.floor(value * 1024 * 1024 * 1024)
  return 0
}

function findJSVarFunc(key: string, data: string): string {
  if (!key || !data) return ''
  const lastNonEmpty = (matches: RegExpMatchArray[]): string => {
    for (let index = matches.length - 1; index >= 0; index--) {
      const value = (matches[index]![1] ?? '').trim().replace(/^['"]|['"]$/g, '')
      if (value) return value
    }
    return ''
  }
  if (key === 'sasign') {
    const matches = Array.from(
      data.matchAll(new RegExp(`(?:var|let|const)?\\s*${key}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`, 'gi')),
    )
    if (matches.length === 3) return (matches[1]![1] ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (matches.length > 0) return lastNonEmpty(matches)
    return ''
  }
  const patterns = [
    new RegExp(`(?:var|let|const)\\s+${key}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`, 'gi'),
    new RegExp(`(?:^|[;,\\s])${key}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`, 'gim'),
    new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]?([\\s\\S]*?)['"]?`, 'gi'),
  ]
  for (const pattern of patterns) {
    const matches = Array.from(data.matchAll(pattern))
    const value = lastNonEmpty(matches)
    if (value) return value
  }
  return ''
}

function mapDataObject(data: string, html: string): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /['"]?([a-zA-Z0-9_$]+)['"]?\s*:\s*(['"]?([^'",}\s]+)['"]?)/g
  for (const match of data.matchAll(pattern)) {
    const key = match[1]!
    const rawValue = match[2]!
    const literal = match[3]
    if (!literal) {
      result[key] = ''
    } else if (rawValue.includes("'") || rawValue.includes('"') || /^\d+$/.test(rawValue)) {
      result[key] = literal
    } else {
      const resolved = findJSVarFunc(literal, html)
      result[key] = resolved || literal
    }
  }
  return result
}

/** Reads the `data: { ... }` / `data: 'a=b&c=d'` object a Lanzou page hands to its ajax calls. */
function htmlJsonToMap(html: string, fullHtml?: string): Record<string, string> {
  const context = fullHtml || html
  const objectMatches = Array.from(html.matchAll(/data\s*:\s*({[\s\S]*?})/g))
  if (objectMatches.length > 0) {
    let best = objectMatches[0]![1]!
    for (const match of objectMatches) {
      if (match[1]!.length > best.length) best = match[1]!
    }
    const mapped = mapDataObject(best, context)
    if (Object.keys(mapped).length > 0) return mapped
  }
  const formMatch = html.match(/data\s*:\s*['"]([^'"]+)['"]/)
  if (formMatch?.[1]?.includes('=')) {
    const mapped: Record<string, string> = {}
    for (const pair of formMatch[1].split('&')) {
      const [key, value] = pair.split('=')
      if (key) mapped[decodeURIComponent(key)] = decodeURIComponent(value ?? '')
    }
    return mapped
  }
  throw DriverError.upstream('Lanzou page had no ajax data object')
}

function getJSFunctionByName(html: string, name: string): string {
  const pattern = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'i')
  const startIndex = html.search(pattern)
  if (startIndex === -1) throw DriverError.upstream(`Lanzou page did not define ${name}`)
  let depth = 0
  for (let index = startIndex; index < html.length; index++) {
    const value = html[index]
    if (value === '{') {
      depth++
    } else if (value === '}') {
      depth--
      if (depth === 0) return html.slice(startIndex, index + 1)
    }
  }
  return html.slice(startIndex)
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function withHost(url: string, host: string): string {
  try {
    const parsed = new URL(url)
    parsed.host = host
    return parsed.toString()
  } catch {
    return url
  }
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function rawToItem(raw: LanzouRawItem, folder: boolean, pwd = ''): LanzouItem {
  const name = String(raw.name_all ?? raw.name ?? '')
  const id = String(folder ? (raw.fol_id ?? raw.id ?? '') : (raw.id ?? raw.fol_id ?? ''))
  return {
    id,
    name,
    isFolder: folder,
    size: folder ? 0 : parseLanzouSize(raw.size),
    modifiedAt: parseLanzouTime(raw.time),
    url: typeof raw.url === 'string' && raw.url ? raw.url : undefined,
    pwd: raw.pwd ?? pwd,
  }
}

function itemEntry(item: LanzouItem): DriverEntry {
  return {
    name: item.name,
    kind: item.isFolder ? 'folder' : 'file',
    size: item.isFolder ? 0 : item.size,
    modifiedAt: item.modifiedAt,
    ref: item.id,
    mime: item.isFolder ? 'application/octet-stream' : driverEntryMime(item.name),
  }
}

class LanzouDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('lanzou')!
  readonly capabilities = this.definition.capabilities

  private jar: CookieJar = {}
  private readonly acw = new Map<string, string>()
  private readonly pathIds = new Map<string, string>()
  private uid = ''
  private vei = ''
  private workingShareHost = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private mode(): 'cookie' | 'account' | 'url' {
    const type = this.configText('type', 'cookie').trim()
    return type === 'account' || type === 'url' ? type : 'cookie'
  }

  private baseUrl(): string {
    return (this.configText('baseUrl', DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private userAgent(): string {
    return this.configText('userAgent', '').trim() || DEFAULT_USER_AGENT
  }

  private shareBase(): string {
    const raw = this.configText('shareUrl', '').trim()
    if (!raw) return DEFAULT_SHARE_URL
    try {
      const parsed = new URL(raw)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return DEFAULT_SHARE_URL
    }
  }

  private configuredShareId(): string {
    const raw = this.configText('shareUrl', '').trim()
    if (raw) {
      try {
        const parsed = new URL(raw)
        const last = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
        if (last) return last
      } catch {
        // A bare share id in shareUrl is accepted below.
      }
      if (!/^https?:/i.test(raw)) return raw.replace(/^\//, '')
    }
    return this.configText('rootFolderId', '').trim()
  }

  private rootId(): string {
    if (this.mode() === 'url') return this.configuredShareId()
    return this.configText('rootFolderId', '-1').trim() || '-1'
  }

  private sharePassword(): string {
    return (this.ctx.credentials.sharePassword ?? '').trim()
  }

  protected async login(force: boolean): Promise<void> {
    const mode = this.mode()
    const stored = (this.ctx.credentials.cookie ?? '').trim()
    this.jar = parseCookies(stored)
    if (mode === 'url') return
    if (mode === 'account') {
      const account = this.configText('account', '').trim()
      const password = (this.ctx.credentials.password ?? '').trim()
      if (!account || !password) {
        throw DriverError.auth('Lanzou account mode needs both an account and a password.')
      }
      if (force || !stored) {
        await this.signIn(account, password)
      } else {
        try {
          await this.initVeiAndUid()
          return
        } catch (error) {
          if (!(error instanceof DriverError) || error.kind !== 'auth') throw error
          await this.signIn(account, password)
        }
      }
      await this.initVeiAndUid()
      return
    }
    if (!stored) {
      throw DriverError.auth('Lanzou cookie mode needs a browser cookie (ylogin / phpdisk_info).')
    }
    await this.initVeiAndUid()
  }

  private async signIn(account: string, password: string): Promise<void> {
    const host = 'up.woozooo.com'
    for (let attempt = 0; attempt < 3; attempt++) {
      const challenge = this.acw.get(host)
      const response = await this.request('https://up.woozooo.com/mlogin.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://pc.woozooo.com',
          'User-Agent': this.userAgent(),
          ...(challenge ? { Cookie: `acw_sc__v2=${challenge}` } : {}),
        },
        body: new URLSearchParams({
          task: '3',
          uid: account,
          pwd: password,
          setSessionId: '',
          setSig: '',
          setScene: '',
          setTocen: '',
          formhash: '',
        }).toString(),
      })
      await this.absorbCookies(response, host)
      const text = await response.text()
      if (text.includes('acw_sc__v2')) {
        this.acw.set(host, calcAcwScV2(text))
        continue
      }
      let payload: { zt?: number; info?: string }
      try {
        payload = JSON.parse(text) as { zt?: number; info?: string }
      } catch {
        throw DriverError.upstream(`Lanzou login returned an unexpected body: ${text.slice(0, 200)}`)
      }
      if (Number(payload.zt) !== 1) {
        throw DriverError.auth(`Lanzou login failed: ${payload.info ?? 'empty answer'}`)
      }
      const cookie = cookieHeader(this.jar)
      if (cookie) await this.saveCredential({ cookie })
      return
    }
    throw DriverError.auth('Lanzou login kept hitting the WAF challenge; try a browser cookie instead.')
  }

  private async initVeiAndUid(): Promise<void> {
    const html = await this.requestText(`${this.baseUrl()}/mydisk.php?item=files&action=index`)
    const uidMatch = html.match(/uid=([^'"&;]+)/)
    if (!uidMatch?.[1]) throw DriverError.auth(COOKIE_EXPIRED_MSG)
    this.uid = uidMatch[1]
    const clean = removeNotes(html)
    try {
      this.vei = htmlJsonToMap(clean).vei ?? ''
    } catch {
      const fallback = html.match(/['"]?vei['"]?\s*:\s*['"]?([^'",\s]+)['"]?/)
      this.vei = fallback?.[1] ?? ''
    }
  }

  private async absorbCookies(response: Response, host: string): Promise<void> {
    const before = cookieHeader(this.jar)
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before && this.mode() !== 'url') {
      await this.saveCredential({ cookie: after })
    }
    const acw = this.jar.acw_sc__v2
    if (acw) this.acw.set(host, acw)
  }

  private isShareHost(host: string): boolean {
    return host === safeHost(this.shareBase()) || (SHARE_DOMAINS as readonly string[]).includes(host)
  }

  /**
   * One text request with WAF handling: replay the per-host acw_sc__v2 cookie, solve a fresh
   * challenge and retry, persist rotated cookies, and fail over between the share domains when a
   * CDN edge blocks the worker's egress IP.
   */
  private async requestText(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, string>,
    referer?: string,
  ): Promise<string> {
    const host = safeHost(url)
    const shareRequest = this.isShareHost(host)
    let target = url
    if (shareRequest && this.workingShareHost && host !== this.workingShareHost) {
      target = withHost(url, this.workingShareHost)
    }
    try {
      return await this.executeText(target, method, body, referer)
    } catch (error) {
      const blocked = shareRequest && error instanceof DriverError &&
        (error.kind === 'auth' || /HTTP 40[35]/.test(error.message))
      if (!blocked) throw error
      const targetHost = safeHost(target)
      for (const domain of SHARE_DOMAINS) {
        if (domain === targetHost) continue
        try {
          const text = await this.executeText(withHost(target, domain), method, body, referer)
          this.workingShareHost = domain
          return text
        } catch (nextError) {
          const stillBlocked = nextError instanceof DriverError &&
            (nextError.kind === 'auth' || /HTTP 40[35]/.test(nextError.message))
          if (!stillBlocked) throw nextError
        }
      }
      throw error
    }
  }

  private async executeText(
    url: string,
    method: 'GET' | 'POST',
    body: Record<string, string> | undefined,
    referer: string | undefined,
  ): Promise<string> {
    const host = safeHost(url)
    for (let attempt = 0; attempt < 3; attempt++) {
      const cookieJar: CookieJar = { ...this.jar }
      if (url.includes('/file/')) cookieJar.down_ip = '1'
      const challenge = this.acw.get(host)
      if (challenge) cookieJar.acw_sc__v2 = challenge
      const origin = (() => {
        try {
          return new URL(url).origin
        } catch {
          return ''
        }
      })()
      const shareRequest = this.isShareHost(host)
      const effectiveReferer = referer || (shareRequest ? `${origin}/` : this.baseUrl())
      const headers: Record<string, string> = {
        Referer: effectiveReferer,
        'User-Agent': this.userAgent(),
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*',
      }
      try {
        if (safeHost(effectiveReferer) === host) headers.Origin = origin
      } catch {
        // A malformed referer simply means no Origin header.
      }
      const cookie = cookieHeader(cookieJar)
      if (cookie) headers.Cookie = cookie
      if (method === 'POST' && body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      }
      const response = await this.request(url, {
        method,
        headers,
        body: method === 'POST' && body ? new URLSearchParams(body).toString() : undefined,
      })
      await this.absorbCookies(response, host)
      const text = await response.text()
      if (text.includes('acw_sc__v2')) {
        this.acw.set(host, calcAcwScV2(text))
        continue
      }
      return text
    }
    throw DriverError.upstream('Lanzou kept answering with a WAF challenge')
  }

  private async personal(params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ uid: this.uid, vei: this.vei })
    const text = await this.requestText(`${this.baseUrl()}/doupload.php?${query.toString()}`, 'POST', params)
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw DriverError.upstream(`Lanzou answered a non-JSON body: ${text.slice(0, 200)}`)
    }
    const zt = Number(payload.zt)
    if (zt === 9) {
      if (this.mode() === 'account') {
        await this.login(true)
        return await this.personal(params)
      }
      throw DriverError.auth(COOKIE_EXPIRED_MSG)
    }
    if (zt !== 1 && zt !== 2 && zt !== 4) {
      throw DriverError.upstream(
        String(payload.inf ?? payload.info ?? `Lanzou rejected the task (zt=${zt})`),
      )
    }
    return payload
  }

  private async getFolders(folderId: string): Promise<LanzouItem[]> {
    const payload = await this.personal({ task: '47', folder_id: folderId || this.rootId() })
    const list = Array.isArray(payload.text) ? payload.text : []
    return list.map((raw) => rawToItem(raw as LanzouRawItem, true))
  }

  private async getFilesPage(folderId: string, page: number): Promise<LanzouItem[]> {
    const payload = await this.personal({
      task: '5',
      folder_id: folderId || this.rootId(),
      pg: String(page),
    })
    const list = Array.isArray(payload.text) ? payload.text : []
    return list.map((raw) => rawToItem(raw as LanzouRawItem, false))
  }

  private async getAllItems(folderId: string): Promise<{ items: LanzouItem[]; truncated: boolean }> {
    const folders = await this.getFolders(folderId)
    const files = await collectPages<LanzouItem>(async ({ page }) => {
      const list = await this.getFilesPage(folderId, page)
      return { items: list, next: list.length > 0 ? String(page) : null }
    }, { mode: 'page', maxPages: MAX_SHARE_PAGES })
    return { items: [...folders, ...files.items], truncated: files.truncated }
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/') {
      if (!root) throw DriverError.invalid('The Lanzou share id is missing from shareUrl/rootFolderId')
      return root
    }
    const segments = clean.split('/').filter(Boolean)
    let parent = root
    let prefix = ''
    let index = 0
    for (; index < segments.length; index++) {
      prefix = `${prefix}/${segments[index]}`
      const cached = this.pathIds.get(prefix)
      if (!cached) break
      parent = cached
    }
    for (; index < segments.length; index++) {
      const raw = segments[index]!
      const decoded = decodeSegment(raw)
      prefix = `${prefix}/${raw}`
      const items = this.mode() === 'url'
        ? (await this.shareListing(parent, this.sharePassword(), 1)).items
        : (await this.getAllItems(parent)).items
      const folder = items.find((item) => {
        if (!item.isFolder) return false
        return item.name === raw || item.name === decoded || item.id === raw || item.id === decoded
      })
      if (!folder?.id) throw DriverError.notFound(`Lanzou folder not found: ${decoded}`)
      parent = folder.id
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<LanzouItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not a file')
    const name = driverFileName(clean)
    const decoded = decodeSegment(name)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const items = this.mode() === 'url'
      ? (await this.shareListing(parentId, this.sharePassword(), 1)).items
      : (await this.getAllItems(parentId)).items
    const found = items.find((item) => {
      return item.name === name || item.name === decoded || item.id === name || item.id === decoded
    })
    if (!found) throw DriverError.notFound(`Lanzou entry not found: ${decoded}`)
    if (found.isFolder && found.id) this.pathIds.set(clean, found.id)
    return found
  }

  private async sharePage(shareId: string): Promise<string> {
    const html = await this.requestText(`${this.shareBase()}/${shareId.replace(/^\//, '')}`)
    if (html.includes('\u53d6\u6d88\u5206\u4eab')) throw DriverError.notFound('The Lanzou share was cancelled')
    if (html.includes('\u6587\u4ef6\u4e0d\u5b58\u5728')) throw DriverError.notFound('The Lanzou share does not exist')
    return html
  }

  private isFileShare(html: string): boolean {
    return /class="fileinfo"|id="file"|\u6587\u4ef6\u63cf\u8ff0/i.test(html)
  }

  private parseSubFolders(html: string): LanzouItem[] {
    const items: LanzouItem[] = []
    for (const match of html.matchAll(
      /(?:folderlink|mbxfolder)[^>]*href=["']\/?([^"']+)["'][^>]*>(.+?)<\//gi,
    )) {
      const id = String(match[1] ?? '')
      const name = String(match[2] ?? '').trim()
      if (id && name) items.push({ id, name, isFolder: true, size: 0, modifiedAt: 0 })
    }
    return items
  }

  private parseShareFileMeta(shareId: string, html: string): LanzouItem {
    let name = shareId
    const title = html.match(/<title>(.+?) - \u84dd\u594f\u4e91<\/title>|id="filenajax">(.+?)<\/div>|var filename = ['"](.+?)['"];/i)
    if (title) {
      for (let index = 1; index < title.length; index++) {
        if (title[index]) {
          name = title[index]!.trim()
          break
        }
      }
    }
    const size = html.match(/\u5927\u5c0f\W*([0-9.]+\s*[bkm]+)/i)
    const time = html.match(/\d+\s*[\u79d2\u5929\u5206\u5c0f][\u949f\u65f6]?\u524d|[\u6628\u524d]\u5929|\d{4}-\d{2}-\d{2}/)
    return {
      id: shareId,
      name,
      isFolder: false,
      size: size?.[1] ? parseLanzouSize(size[1]) : 0,
      modifiedAt: time?.[0] ? parseLanzouTime(time[0]) : 0,
      pwd: this.sharePassword(),
    }
  }

  private async shareFilePage(
    shareId: string,
    html: string,
    pwd: string,
    page: number,
  ): Promise<{ items: LanzouItem[]; next: string | null }> {
    let form: Record<string, string> = {}
    try {
      form = htmlJsonToMap(removeNotes(html))
    } catch {
      form = {}
    }
    form.pwd = pwd || this.sharePassword()
    form.pg = String(page)
    const text = await this.requestText(
      `${this.shareBase()}/filemoreajax.php`,
      'POST',
      form,
      `${this.shareBase()}/${shareId}`,
    )
    let payload: { zt?: number; text?: unknown }
    try {
      payload = JSON.parse(text) as { zt?: number; text?: unknown }
    } catch {
      return { items: [], next: null }
    }
    if (Number(payload.zt) !== 1 || !Array.isArray(payload.text) || payload.text.length === 0) {
      return { items: [], next: null }
    }
    const items = payload.text.map((raw) =>
      rawToItem(raw as LanzouRawItem, false, form.pwd),
    )
    return { items, next: String(page + 1) }
  }

  private async shareListing(
    shareId: string,
    pwd: string,
    page?: number,
  ): Promise<{ items: LanzouItem[]; next: string | null; truncated: boolean }> {
    if (!shareId) throw DriverError.invalid('The Lanzou share id is missing')
    const html = await this.sharePage(shareId)
    if (this.isFileShare(html)) {
      return { items: [this.parseShareFileMeta(shareId, html)], next: null, truncated: false }
    }
    const folders = (page === undefined || page === 1) ? this.parseSubFolders(html) : []
    if (page !== undefined) {
      const result = await this.shareFilePage(shareId, html, pwd, Math.max(1, page))
      return { items: [...folders, ...result.items], next: result.next, truncated: result.next !== null }
    }
    const files: LanzouItem[] = []
    let next: string | null = '1'
    let truncated = false
    for (let round = 0; next !== null; round++) {
      if (round >= MAX_SHARE_PAGES) {
        truncated = true
        break
      }
      const result = await this.shareFilePage(shareId, html, pwd, Number(next) || 1)
      files.push(...result.items)
      next = result.next
    }
    return { items: [...folders, ...files], next: null, truncated }
  }

  /**
   * Resolves a single share page into a real download address: password pages go through
   * `ajaxfile.php`, public pages first follow the `/fn?` iframe. The resulting `/file/` URL is then
   * probed for its redirect so `directLink` returns the address a client can use.
   */
  private async resolveShareLink(shareId: string, pwd: string): Promise<LanzouShareLink> {
    const cleanId = shareId.replace(/^\//, '')
    const pageUrl = `${this.shareBase()}/${cleanId}`
    const rawPage = await this.sharePage(cleanId)
    const page = removeJSComment(removeNotes(rawPage))
    let baseUrl = ''
    let downloadUrl = ''
    let name = cleanId

    const needsPassword = page.includes('pwdload') || page.includes('passwddiv')
    if (needsPassword) {
      const fnCode = getJSFunctionByName(page, 'down_p')
      const params = htmlJsonToMap(fnCode, page)
      params.p = pwd || this.sharePassword()
      const fileId = this.findFileId(fnCode) || this.findFileId(page)
      if (!fileId) throw DriverError.upstream('Lanzou share page had no file id')
      const payload = await this.shareAjax(params, fileId, pageUrl)
      baseUrl = `${String(payload.dom ?? '')}/file`
      downloadUrl = `${baseUrl}/${String(payload.url ?? '')}`
    } else {
      const iframe = page.match(/<iframe[^>]*?src=["']([^"']+)["']/i) ||
        page.match(/href=["'](\/fn\?[^"']+)["']/i) ||
        page.match(/["'](\/fn\?[^"']+)["']/i)
      if (!iframe?.[1]) throw DriverError.upstream('Lanzou share page had no download iframe')
      const path = iframe[1]
      const iframeUrl = `${this.shareBase()}${path.startsWith('/') ? '' : '/'}${path}`
      const nextPage = removeNotes(await this.requestText(iframeUrl, 'GET', undefined, pageUrl))
      const params = htmlJsonToMap(nextPage, nextPage)
      const fileId = this.findFileId(nextPage)
      if (!fileId) throw DriverError.upstream('Lanzou download page had no file id')
      const payload = await this.shareAjax(params, fileId, iframeUrl)
      baseUrl = `${String(payload.dom ?? '')}/file`
      downloadUrl = `${baseUrl}/${String(payload.url ?? '')}`
      const nameMatch = page.match(
        /<title>(.+?) - \u84dd\u594f\u4e91<\/title>|id="filenajax">(.+?)<\/div>|var filename = ['"](.+?)['"];|<div class="filethetext"[^>]*>([^<>]+)<\/div>/i,
      )
      if (nameMatch) {
        for (let index = 1; index < nameMatch.length; index++) {
          if (nameMatch[index]) {
            name = nameMatch[index]!.trim()
            break
          }
        }
      }
    }

    if (!downloadUrl || downloadUrl.endsWith('/undefined')) {
      throw DriverError.upstream('Lanzou did not hand back a download address')
    }
    const direct = await this.probeDirectLink(downloadUrl, baseUrl)
    const sizeMatch = page.match(/\u5927\u5c0f\W*([0-9.]+\s*[bkm]+)/i)
    const timeMatch = page.match(/\d+\s*[\u79d2\u5929\u5206\u5c0f][\u949f\u65f6]?\u524d|[\u6628\u524d]\u5929|\d{4}-\d{2}-\d{2}/)
    return {
      url: direct,
      name,
      size: sizeMatch?.[1] ? parseLanzouSize(sizeMatch[1]) : 0,
      modifiedAt: timeMatch?.[0] ? parseLanzouTime(timeMatch[0]) : 0,
    }
  }

  private findFileId(source: string): string {
    const match = source.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
      source.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
      source.match(/var\s+file_id\s*=\s*['"]?(\d+)['"]?/)
    return match?.[1] ?? ''
  }

  private async shareAjax(
    params: Record<string, string>,
    fileId: string,
    referer: string,
  ): Promise<Record<string, unknown>> {
    const text = await this.requestText(
      `${this.shareBase()}/ajaxfile.php?file=${fileId}`,
      'POST',
      params,
      referer,
    )
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw DriverError.upstream('Lanzou ajaxfile.php answered a non-JSON body')
    }
    if (Number(payload.zt) !== 1) {
      throw DriverError.upstream(
        String(payload.info ?? payload.text ?? `Lanzou rejected the share request (zt=${payload.zt})`),
      )
    }
    return payload
  }

  private async probeDirectLink(downloadUrl: string, baseUrl: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = {
        Referer: baseUrl,
        'User-Agent': this.userAgent(),
      }
      const challenge = this.jar.acw_sc__v2
      headers.Cookie = challenge ? `down_ip=1; acw_sc__v2=${challenge}` : 'down_ip=1'
      const response = await fetch(downloadUrl, { method: 'GET', headers, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (location) return new URL(location, downloadUrl).toString()
      }
      if (response.status === 200 && response.url && response.url !== downloadUrl) {
        await response.body?.cancel().catch(() => undefined)
        return response.url
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      const text = await response.text()
      if (text.includes('acw_sc__v2')) {
        const value = calcAcwScV2(text)
        this.jar.acw_sc__v2 = value
        continue
      }
      break
    }
    throw DriverError.upstream('Lanzou could not resolve the download address')
  }

  private async fileLink(item: LanzouItem): Promise<string> {
    if (item.url) return item.url
    if (this.mode() === 'url') {
      const link = await this.resolveShareLink(item.id, item.pwd || this.sharePassword())
      item.url = link.url
      return link.url
    }
    const payload = await this.personal({ task: '22', file_id: item.id })
    const info = (payload.info ?? {}) as { f_id?: string; id?: string; pwd?: string }
    const shareId = String(info.f_id ?? info.id ?? '')
    if (!shareId) throw DriverError.upstream('Lanzou did not return a share id for that file')
    const link = await this.resolveShareLink(shareId, String(info.pwd ?? ''))
    item.url = link.url
    return link.url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(path)
      if (this.mode() === 'url') {
        const listing = await this.shareListing(folderId, this.sharePassword(), options.page)
        return {
          entries: listing.items.map(itemEntry),
          cursor: listing.next,
          truncated: options.page !== undefined ? listing.next !== null : listing.truncated,
        }
      }
      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const folders = page === 1 ? await this.getFolders(folderId) : []
        const files = await this.getFilesPage(folderId, page)
        const next = files.length > 0 ? String(page + 1) : null
        return {
          entries: [...folders, ...files].map(itemEntry),
          cursor: next,
          truncated: next !== null,
        }
      }
      const all = await this.getAllItems(folderId)
      return { entries: all.items.map(itemEntry), cursor: null, truncated: all.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() }
      }
      return itemEntry(await this.resolveEntry(clean))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.fileLink(item)
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': this.userAgent(),
          Referer: this.mode() === 'url' ? this.shareBase() : this.baseUrl(),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Lanzou download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) return null
      return await this.fileLink(item)
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported(
      'Lanzou has no upload endpoint this worker can drive; upload through the Lanzou web UI instead.',
    )
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    this.requirePersonal('mkdir')
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') throw DriverError.invalid('A folder name is required')
      const name = driverFileName(clean)
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      await this.personal({ task: '2', parent_id: parentId, folder_name: name, folder_description: '' })
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    driverPath(path)
    if (!newName || newName === '.' || newName === '..' || newName.includes('/')) {
      throw DriverError.invalid('The new name is invalid')
    }
    this.requirePersonal('rename')
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) {
        throw DriverError.unsupported('Lanzou cannot rename a folder; only files can be renamed.')
      }
      await this.personal({ task: '46', file_id: item.id, file_name: newName, type: '2' })
      this.pathIds.clear()
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    this.requirePersonal('move')
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(fromPath)
      if (item.isFolder) {
        throw DriverError.unsupported('Lanzou cannot move a folder; only files can be moved.')
      }
      const target = driverPath(toPath)
      if (target === '/') throw DriverError.invalid('A destination entry name is required')
      const targetParent = await this.resolveFolderId(driverParentPath(target))
      await this.personal({ task: '20', file_id: item.id, folder_id: targetParent })
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    this.requirePersonal('remove')
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) {
        await this.personal({ task: '3', folder_id: item.id })
      } else {
        await this.personal({ task: '6', file_id: item.id })
      }
      this.pathIds.clear()
    })
  }

  private requirePersonal(action: string): void {
    if (this.mode() === 'url') {
      throw DriverError.unsupported(`A public Lanzou share cannot ${action}; mount it in cookie or account mode.`)
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      if (this.mode() === 'url') {
        await this.sharePage(this.rootId())
        return { ok: true, message: 'The Lanzou share is reachable' }
      }
      await this.getFolders(this.rootId())
      return { ok: true, message: 'Lanzou is reachable and the cookie is accepted' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Lanzou is unavailable' }
    }
  }
}

export function createLanzouDriver(ctx: DriverContext): MountDriver {
  return new LanzouDriver(ctx)
}
