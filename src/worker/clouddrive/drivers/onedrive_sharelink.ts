/**
 * OneDrive / SharePoint share-link driver (read-only).
 *
 * Ported from the reference implementation at
 * `OpenList-Worker/src/backend/drivers/onedrive_sharelink`: the share URL is resolved to the real
 * SharePoint folder, the folder listing is read through `renderListDataAsStream`, and bind items
 * are downloaded from `@microsoft.graph.downloadUrl` or the share's own `download.aspx` endpoint.
 * Pagination follows the `ListData.NextHref` cursor the same way the reference driver does.
 *
 * A password-protected link is unlocked through the share page's `inputForm` (VIEWSTATE +
 * EVENTVALIDATION + txtPassword), and the resulting `FedAuth` cookie is reused for every request.
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

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inkstone-clouddrive'
const MAX_PAGES = 50

interface SharePointRow {
  FSObjType?: string | number
  FileLeafRef?: string
  'File_x0020_Size'?: string
  UniqueId?: string
  'Modified.'?: string
  '@content.downloadUrl'?: string
  '@microsoft.graph.downloadUrl'?: string
  '.spItemUrl'?: string
}

interface SharePointListData {
  Row?: SharePointRow[]
  NextHref?: string
}

interface SharePointPayload {
  ListData?: SharePointListData
  legacy?: { renderListDataAsStream?: { ListData?: SharePointListData } }
}

interface RowPage {
  rows: SharePointRow[]
  next: string | null
}

class OneDriveShareLinkDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('onedrive_sharelink')!
  readonly capabilities = this.definition.capabilities
  private finalUrl = ''
  private referer = ''
  private cookie = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    const url = this.configText('url').trim()
    if (!url) throw DriverError.auth('OneDrive Share Link needs the sharing URL.')
    const password = this.ctx.credentials.password ?? this.configText('password')
    this.finalUrl = url
    this.referer = url
    this.cookie = ''
    if (password) {
      this.cookie = await this.unlockWithPassword(url, password)
      return
    }
    await this.resolveAnonymousLink(url)
  }

  private async rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw DriverError.upstream(
        `The share link could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async failure(response: Response): Promise<never> {
    const text = await response.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(text) as { message?: unknown; msg?: unknown; error?: unknown }
      if (typeof parsed.message === 'string') message = parsed.message
      else if (typeof parsed.msg === 'string') message = parsed.msg
      else if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      message = text.slice(0, 200)
    }
    const suffix = message ? `: ${message}` : ''
    if (response.status === 401 || response.status === 403) {
      throw DriverError.auth(`The OneDrive share refused the request (HTTP ${response.status}${suffix})`)
    }
    if (response.status === 404) throw DriverError.notFound(`Not found upstream (HTTP 404${suffix})`)
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'))
      throw DriverError.rateLimited(
        `The OneDrive share is rate limiting requests${suffix}`,
        Number.isFinite(retry) ? retry * 1000 : undefined,
      )
    }
    throw DriverError.upstream(`The OneDrive share answered HTTP ${response.status}${suffix}`)
  }

  private async resolveAnonymousLink(url: string): Promise<void> {
    const response = await this.rawFetch(url, { method: 'GET', redirect: 'manual' })
    const location = response.headers.get('location')
    const cookies = this.cookieHeaderFrom(response)
    if (location) {
      const target = new URL(location, url).toString()
      this.referer = target
      this.finalUrl = target
      this.cookie = cookies
      await response.body?.cancel().catch(() => undefined)
      return
    }
    if (!response.ok) await this.failure(response)
    const html = await response.clone().text().catch(() => '')
    if (/inputForm|txtPassword/i.test(html)) {
      throw DriverError.auth('This OneDrive share link is password protected; provide the share password.')
    }
    this.cookie = cookies
    await response.body?.cancel().catch(() => undefined)
  }

  /** Reads a named cookie pair from a response, including a multi-value `Set-Cookie` header. */
  private cookieHeaderFrom(response: Response, wanted?: string): string {
    const raw = response.headers.get('set-cookie') ?? ''
    const parts = raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    const pairs: string[] = []
    for (const part of parts) {
      const pair = part.split(';', 1)[0]?.trim() ?? ''
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      if (name.toLowerCase() === 'fedauth') {
        if (wanted === 'FedAuth') return pair.slice(index + 1).trim()
        pairs.push(pair)
      } else if (!wanted) {
        pairs.push(pair)
      }
    }
    return wanted ? '' : pairs.join('; ')
  }

  private inputValue(html: string, id: string): string {
    const tags = html.match(/<input\b[^>]*>/gi) ?? []
    for (const tag of tags) {
      const idMatch = /id\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
      const name = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim()
      if (name !== id) continue
      const valueMatch = /value\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
      return valueMatch?.[1] ?? valueMatch?.[2] ?? ''
    }
    return ''
  }

  private formAction(html: string, url: string): string {
    const form = /<form\b[^>]*id\s*=\s*(?:"inputForm"|'inputForm')[^>]*>/i.exec(html)?.[0] ?? ''
    const match = /action\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(form)
    const action = match?.[1] ?? match?.[2] ?? ''
    return action ? new URL(action, url).toString() : url
  }

  private async unlockWithPassword(url: string, password: string): Promise<string> {
    const page = await this.rawFetch(url, { method: 'GET', redirect: 'manual' })
    const html = await page.text().catch(() => '')
    if (!page.ok && page.status !== 0) {
      if (page.status === 401 || page.status === 403) {
        throw DriverError.auth('The OneDrive share password was rejected.')
      }
      if (page.status === 404) throw DriverError.notFound('The OneDrive share link does not exist.')
    }
    const action = this.formAction(html, url)
    const body = new URLSearchParams({
      txtPassword: password,
      __EVENTVALIDATION: this.inputValue(html, '__EVENTVALIDATION'),
      __VIEWSTATE: this.inputValue(html, '__VIEWSTATE'),
      __VIEWSTATEENCRYPTED: '',
    })
    const response = await this.rawFetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    })
    if (response.status === 401 || response.status === 403) {
      throw DriverError.auth('The OneDrive share password was rejected.')
    }
    const cookie = this.cookieHeaderFrom(response, 'FedAuth')
    await response.body?.cancel().catch(() => undefined)
    if (!cookie) throw DriverError.auth('The OneDrive share password was rejected.')
    this.finalUrl = url
    this.referer = url
    return `FedAuth=${cookie}`
  }

  private isSingleFileLink(): boolean {
    const pathname = new URL(this.finalUrl).pathname
    return pathname.includes('/:u:/') || pathname.includes('/:v:/') || pathname.includes('/:b:/')
  }

  private singleFileName(): string {
    const segments = new URL(this.finalUrl).pathname.split('/').filter(Boolean)
    return decodeURIComponent(segments[segments.length - 1] ?? 'file')
  }

  private rootFolder(): string {
    try {
      const id = new URL(this.finalUrl).searchParams.get('id')
      return id ? decodeURIComponent(id) : ''
    } catch {
      return ''
    }
  }

  private apiUrl(folder: string): string {
    const url = new URL(this.finalUrl)
    const pathname = url.pathname.replace(/\/+$/, '')
    const root = this.rootFolder()
    const separator = root.includes('Documents') ? root.indexOf('Documents') : -1
    const listUrl = separator >= 0 ? `${root.slice(0, separator)}Documents` : root
    const folderUrl = root ? (folder === '/' ? root : `${root}${folder}`) : folder
    const api = new URL(`${url.origin}${pathname}/_api/web/GetListUsingPath(DecodedUrl=@a1)/renderListDataAsStream`)
    api.searchParams.set('@a1', `'${listUrl}'`)
    if (folderUrl) api.searchParams.set('RootFolder', folderUrl)
    api.searchParams.set('TryNewExperienceSingle', 'TRUE')
    return api.toString()
  }

  private renderBody(folder: string): string {
    const root = this.rootFolder()
    const folderUrl = root ? (folder === '/' ? root : `${root}${folder}`) : folder
    return JSON.stringify({
      parameters: {
        RenderOptions: 5707,
        AllowMultipleValueFilterForTaxonomyFields: true,
        AddRequiredFields: true,
        ...(folderUrl ? { folderServerRelativeUrl: folderUrl } : {}),
      },
    })
  }

  private async fetchRows(folder: string, next: string | null): Promise<RowPage> {
    const target = next
      ? new URL(next, new URL(this.finalUrl).origin).toString()
      : this.apiUrl(folder)
    const response = await this.request(target, {
      method: 'POST',
      headers: {
        Accept: 'application/json;odata=nometadata',
        'Content-Type': 'application/json;odata=verbose',
        'User-Agent': USER_AGENT,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.referer ? { Referer: this.referer } : {}),
      },
      body: this.renderBody(folder),
      retries: 0,
      redirect: 'follow',
      timeoutMs: 30_000,
    })
    const payload = await response.json().catch(() => null) as SharePointPayload | null
    const listData = payload?.ListData
      ?? payload?.legacy?.renderListDataAsStream?.ListData
    const rows = listData?.Row ?? []
    const href = listData?.NextHref ?? null
    return { rows, next: href || null }
  }

  private rowId(row: SharePointRow): string {
    return String(row.UniqueId ?? '').replace(/^\{+|\}+$/g, '')
  }

  private rowEntry(row: SharePointRow): DriverEntry {
    const folder = String(row.FSObjType ?? '0') === '1'
    const name = String(row.FileLeafRef ?? '')
    const size = folder ? 0 : Number.parseInt(String(row['File_x0020_Size'] ?? '0'), 10) || 0
    const modified = Date.parse(String(row['Modified.'] ?? '')) || 0
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size,
      modifiedAt: modified,
      ref: this.rowId(row) || name,
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  private async collectRows(folder: string, options: DriverListOptions): Promise<{ rows: SharePointRow[]; cursor: string | null; truncated: boolean }> {
    let current = await this.fetchRows(folder, null)
    if (options.page !== undefined) {
      const target = Math.max(1, Math.floor(options.page))
      let page = 1
      while (page < target) {
        if (!current.next) return { rows: [], cursor: null, truncated: false }
        current = await this.fetchRows(folder, current.next)
        page++
      }
      return { rows: current.rows, cursor: current.next, truncated: current.next !== null }
    }
    const rows = [...current.rows]
    let pages = 1
    while (current.next && pages < MAX_PAGES) {
      current = await this.fetchRows(folder, current.next)
      rows.push(...current.rows)
      pages++
    }
    return { rows, cursor: null, truncated: current.next !== null }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      if (this.isSingleFileLink()) {
        const name = this.singleFileName()
        return {
          entries: [{ name, kind: 'file', size: 0, modifiedAt: 0, ref: 'root_file', mime: driverEntryMime(name) }],
          cursor: null,
          truncated: false,
        }
      }
      const folder = this.folderPath(clean)
      const collected = await this.collectRows(folder, options)
      const query = (options.search ?? '').trim().toLowerCase()
      const rows = query
        ? collected.rows.filter((row) => String(row.FileLeafRef ?? '').toLowerCase().includes(query))
        : collected.rows
      return {
        entries: rows.map((row) => this.rowEntry(row)),
        cursor: collected.cursor,
        truncated: collected.truncated,
      }
    })
  }

  private folderPath(clean: string): string {
    const root = driverPath(this.configText('rootPath', '/'))
    if (clean === '/') return root
    return root === '/' ? clean : `${root}${clean}`
  }

  private async findRow(clean: string): Promise<SharePointRow | null> {
    const name = driverFileName(clean)
    const folder = this.folderPath(driverParentPath(clean))
    let current = await this.fetchRows(folder, null)
    let pages = 1
    for (;;) {
      const hit = current.rows.find((row) => String(row.FileLeafRef ?? '') === name)
      if (hit) return hit
      if (!current.next || pages >= MAX_PAGES) return null
      current = await this.fetchRows(folder, current.next)
      pages++
    }
  }

  private downloadOf(row: SharePointRow): string {
    const content = row['@microsoft.graph.downloadUrl'] || row['@content.downloadUrl'] || ''
    if (content) return content
    const id = this.rowId(row)
    if (!id) throw DriverError.upstream('The OneDrive share returned no download address.')
    const url = new URL(this.finalUrl)
    const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
    return `${url.origin}${dir}/download.aspx?UniqueId=${encodeURIComponent(id)}`
  }

  private sharedDownloadUrl(): string {
    const url = new URL(this.finalUrl)
    url.searchParams.set('download', '1')
    return url.toString()
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: 'root' }
      }
      if (this.isSingleFileLink()) {
        const name = this.singleFileName()
        return { name, kind: 'file', size: 0, modifiedAt: 0, ref: 'root_file', mime: driverEntryMime(name) }
      }
      const row = await this.findRow(clean)
      if (!row) throw DriverError.notFound(`The OneDrive share has no entry at ${clean}`)
      return this.rowEntry(row)
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
      let url = ''
      if (this.isSingleFileLink()) {
        url = this.sharedDownloadUrl()
      } else {
        const row = await this.findRow(clean)
        if (!row) throw DriverError.notFound(`The OneDrive share has no entry at ${clean}`)
        if (String(row.FSObjType ?? '0') === '1') {
          throw DriverError.unsupported('A folder cannot be read as a file')
        }
        url = this.downloadOf(row)
      }
      const response = await this.rawFetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(this.referer ? { Referer: this.referer } : {}),
        },
      })
      if (!response.ok && response.status !== 206) await this.failure(response)
      return response
    })
  }

  async upload(): Promise<void> {
    throw DriverError.unsupported('OneDrive Share Link is read-only')
  }

  async mkdir(): Promise<void> {
    throw DriverError.unsupported('OneDrive Share Link is read-only')
  }

  async rename(): Promise<void> {
    throw DriverError.unsupported('OneDrive Share Link is read-only')
  }

  async move(): Promise<void> {
    throw DriverError.unsupported('OneDrive Share Link is read-only')
  }

  async remove(): Promise<void> {
    throw DriverError.unsupported('OneDrive Share Link is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      return { ok: true, message: `OneDrive share is reachable · ${new URL(this.finalUrl).host}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'OneDrive share is unavailable' }
    }
  }
}

export function createOneDriveShareLinkDriver(ctx: DriverContext): MountDriver {
  return new OneDriveShareLinkDriver(ctx)
}
