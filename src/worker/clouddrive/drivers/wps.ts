/**
 * WPS (Kingsoft Docs) drive driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/wps`: a `wps_sid` browser Cookie is validated at
 * `account.kdocs.cn/api/v3/islogin`, Personal accounts use `drive.wps.cn` while Business accounts
 * use `365.kdocs.cn/3rd/drive`, file listings page by `offset`/`next_offset`, and download links are
 * short-lived ks3 URLs that keep working only with the WPS UA and Referer.
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
import { cookieHeader, mergeResponseCookies, parseCookies, type CookieJar } from './cookies'
import {
  HttpDriverBase,
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const ENDPOINT_BUSINESS = 'https://365.kdocs.cn'
const ENDPOINT_PERSONAL = 'https://drive.wps.cn'
const LOGIN_STATE_URL = 'https://account.kdocs.cn/api/v3/islogin'
const MAX_FILE_PAGES = 50
const PAGE_SIZE = 100
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface WpsLoginState {
  companyid?: number
  is_company_account?: boolean
}

interface WpsGroup {
  group_id?: number
  id?: number
  name: string
}

interface WpsFile {
  groupid: number
  parentid: number
  fname: string
  fsize?: number
  ftype: string
  mtime?: number
  id: number
}

interface ResolvedNode {
  kind: 'root' | 'group' | 'folder' | 'file'
  groupId: number
  fileId: number
  name: string
  isDir: boolean
  size: number
  modifiedAt: number
}

interface WpsResponse {
  result?: string
  msg?: string
  message?: string
}

function modifiedAt(seconds: number | undefined): number {
  if (!seconds || !Number.isFinite(seconds)) return 0
  return seconds < 1e12 ? seconds * 1000 : seconds
}

function groupEntry(group: WpsGroup): DriverEntry {
  const id = Number(group.group_id ?? group.id ?? 0)
  return {
    name: group.name,
    kind: 'folder',
    size: 0,
    modifiedAt: 0,
    ref: String(id),
    mime: 'application/octet-stream',
  }
}

function fileEntry(file: WpsFile): DriverEntry {
  const folder = file.ftype === 'folder'
  return {
    name: file.fname,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.fsize) || 0,
    modifiedAt: modifiedAt(file.mtime),
    ref: String(file.id),
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.fname),
  }
}

class WpsDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('wps')!
  readonly capabilities = this.definition.capabilities
  private jar: CookieJar = {}
  private loginState: WpsLoginState | null = null

  protected async login(): Promise<void> {
    const raw = this.ctx.credentials.cookie ?? ''
    if (!raw.trim()) {
      const message = 'WPS needs a browser Cookie for this account'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.jar = parseCookies(raw)
    this.loginState = null
    try {
      this.loginState = await this.jsonRequest<WpsLoginState>(LOGIN_STATE_URL, { method: 'GET' })
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  private rootFolderPath(): string {
    return driverPath(this.configText('rootFolderPath', '').trim() || '/')
  }

  /** Maps a mount-relative path onto the path under an optional `rootFolderPath`. */
  private mountPath(path: string): string {
    const clean = driverPath(path)
    const root = this.rootFolderPath()
    if (root === '/') return clean
    return clean === '/' ? root : driverChildPath(root, clean.slice(1))
  }

  private isPersonal(): boolean {
    if (this.loginState?.is_company_account !== undefined) return !this.loginState.is_company_account
    return this.configText('mode', 'Personal') !== 'Business'
  }

  private driveHost(): string {
    return this.isPersonal() ? ENDPOINT_PERSONAL : ENDPOINT_BUSINESS
  }

  private driveUrl(path: string): string {
    return this.isPersonal() ? `${ENDPOINT_PERSONAL}${path}` : `${ENDPOINT_BUSINESS}/3rd/drive${path}`
  }

  private headers(body: boolean): Record<string, string> {
    return {
      Cookie: cookieHeader(this.jar),
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Origin: this.driveHost(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async absorbCookies(response: Response): Promise<void> {
    const before = cookieHeader(this.jar)
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before) await this.saveCredential({ cookie: after })
  }

  private async jsonRequest<T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; params?: Record<string, string> } = {},
  ): Promise<T> {
    const target = new URL(url)
    for (const [key, value] of Object.entries(options.params ?? {})) target.searchParams.set(key, value)
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const response = await this.request(target.toString(), {
      method: options.method ?? 'GET',
      headers: this.headers(body !== undefined),
      body,
    })
    await this.absorbCookies(response)
    let payload: (T & WpsResponse) | null
    try {
      payload = await response.json() as T & WpsResponse
    } catch {
      throw DriverError.upstream('WPS returned a body that is not JSON')
    }
    const result = payload.result
    if (result && result !== 'ok' && result !== 'success') {
      const message = payload.msg || payload.message || result
      if (/login|unauthor|\u767b\u5f55|\u672a\u767b\u5f55/i.test(`${result} ${message}`)) throw DriverError.auth(message)
      if (`${result} ${message}`.includes('429')) throw DriverError.rateLimited(message)
      if (`${result} ${message}`.includes('404')) throw DriverError.notFound(message)
      throw DriverError.upstream(message)
    }
    return payload
  }

  private async getGroups(): Promise<WpsGroup[]> {
    if (this.isPersonal()) {
      const result = await this.jsonRequest<{ groups?: { id: number; name: string }[] }>(this.driveUrl('/api/v3/groups'))
      return (result.groups ?? []).map((group) => ({ group_id: group.id, id: group.id, name: group.name }))
    }
    const companyId = this.loginState?.companyid ?? 0
    const url = `${ENDPOINT_BUSINESS}/3rd/plus/groups/v1/companies/${companyId}/users/self/groups/private`
    const result = await this.jsonRequest<{ groups?: WpsGroup[] }>(url)
    return result.groups ?? []
  }

  private async getFiles(groupId: number, parentId: number): Promise<{ files: WpsFile[]; truncated: boolean }> {
    const files: WpsFile[] = []
    let offset = 0
    for (let page = 0; page < MAX_FILE_PAGES; page++) {
      const result = await this.jsonRequest<{ files?: WpsFile[]; next_offset?: number }>(
        this.driveUrl(`/api/v5/groups/${groupId}/files`),
        { params: { parentid: String(parentId), offset: String(offset) } },
      )
      files.push(...(result.files ?? []))
      if (result.next_offset === undefined || result.next_offset === -1) return { files, truncated: false }
      offset = result.next_offset
    }
    return { files, truncated: true }
  }

  private async findChild(groupId: number, parentId: number, name: string): Promise<WpsFile | null> {
    const listed = await this.getFiles(groupId, parentId)
    return listed.files.find((file) => file.fname === name) ?? null
  }

  private async getDownloadUrl(groupId: number, fileId: number): Promise<string> {
    const result = await this.jsonRequest<{ url?: string }>(
      this.driveUrl(`/api/v5/groups/${groupId}/files/${fileId}/download?support_checksums=sha1`),
    )
    if (!result.url) throw DriverError.upstream('WPS returned no download address')
    return result.url
  }

  private async resolvePath(path: string): Promise<ResolvedNode | null> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { kind: 'root', groupId: 0, fileId: 0, name: 'root', isDir: true, size: 0, modifiedAt: 0 }
    }
    const parts = clean.split('/').filter(Boolean)
    const groups = await this.getGroups()
    const group = groups.find((entry) => entry.name === parts[0])
    if (!group) return null
    const groupId = Number(group.group_id ?? group.id ?? 0)
    if (parts.length === 1) {
      return { kind: 'group', groupId, fileId: 0, name: group.name, isDir: true, size: 0, modifiedAt: 0 }
    }
    let parentId = 0
    let node: ResolvedNode | null = null
    for (let index = 1; index < parts.length; index++) {
      const files = await this.getFiles(groupId, parentId)
      const found = files.files.find((file) => file.fname === parts[index])
      if (!found) return null
      const isDir = found.ftype === 'folder'
      node = {
        kind: isDir ? 'folder' : 'file',
        groupId,
        fileId: found.id,
        name: found.fname,
        isDir,
        size: isDir ? 0 : Number(found.fsize) || 0,
        modifiedAt: modifiedAt(found.mtime),
      }
      parentId = found.id
    }
    return node
  }

  private async requirePath(path: string): Promise<ResolvedNode> {
    const node = await this.resolvePath(path)
    if (!node) throw DriverError.notFound(`Path not found: ${path}`)
    return node
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = this.mountPath(path)
    return await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (!node.isDir) throw DriverError.notFound('The path is not a folder')
      let entries: DriverEntry[]
      let truncated = false
      if (node.kind === 'root') {
        entries = (await this.getGroups()).map(groupEntry)
      } else {
        const listed = await this.getFiles(node.groupId, node.fileId)
        entries = listed.files.map(fileEntry)
        truncated = listed.truncated
      }
      const filtered = options.search
        ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(options.search!.toLocaleLowerCase()))
        : entries
      const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
      if (options.page === undefined) {
        return { entries: filtered, cursor: null, truncated }
      }
      const page = Math.max(1, options.page)
      const offset = (page - 1) * pageSize
      const entriesForPage = filtered.slice(offset, offset + pageSize)
      const cursor = offset + pageSize < filtered.length ? String(page + 1) : null
      return { entries: entriesForPage, cursor, truncated: cursor !== null || truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = this.mountPath(path)
    return await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (node.kind === 'root' || node.kind === 'group') {
        return { name: node.name, kind: 'folder', size: 0, modifiedAt: node.modifiedAt, ref: String(node.groupId) }
      }
      return {
        name: node.name,
        kind: node.isDir ? 'folder' : 'file',
        size: node.size,
        modifiedAt: node.modifiedAt,
        ref: String(node.fileId),
        mime: node.isDir ? 'application/octet-stream' : driverEntryMime(node.name),
      }
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = this.mountPath(path)
    return await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (node.kind !== 'file') throw DriverError.unsupported('A folder cannot be read as a file')
      const link = await this.getDownloadUrl(node.groupId, node.fileId)
      const response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: this.driveHost(),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401 || response.status === 403) throw DriverError.auth('WPS refused the download')
        throw DriverError.upstream(`WPS download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = this.mountPath(path)
    return await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (node.kind !== 'file') return null
      return await this.getDownloadUrl(node.groupId, node.fileId)
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    this.mountPath(path)
    throw DriverError.unsupported('WPS requires its chunked upload protocol, which the reference driver does not implement')
  }

  async mkdir(path: string): Promise<void> {
    const relative = driverPath(path)
    if (relative === '/') return
    const clean = this.mountPath(relative)
    await this.withAuth(async () => {
      const parent = await this.requirePath(driverParentPath(clean))
      if (!parent.isDir || parent.kind === 'root') throw DriverError.unsupported('WPS groups are read-only at the root')
      await this.jsonRequest(this.driveUrl('/api/v5/files/folder'), {
        method: 'POST',
        body: { groupid: parent.groupId, parentid: parent.fileId, name: driverFileName(clean) },
      })
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = this.mountPath(path)
    await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (node.kind === 'root' || node.kind === 'group') throw DriverError.unsupported('WPS groups cannot be renamed')
      await this.jsonRequest(this.driveUrl(`/api/v3/groups/${node.groupId}/files/${node.fileId}`), {
        method: 'PUT',
        body: { fname: newName },
      })
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = this.mountPath(fromPath)
    const to = this.mountPath(toPath)
    if (from === to) return
    await this.withAuth(async () => {
      const source = await this.requirePath(from)
      if (source.kind === 'root' || source.kind === 'group') throw DriverError.unsupported('WPS groups cannot be moved')
      const targetName = driverFileName(to)
      if (source.name !== targetName) {
        await this.jsonRequest(this.driveUrl(`/api/v3/groups/${source.groupId}/files/${source.fileId}`), {
          method: 'PUT',
          body: { fname: targetName },
        })
      }
      const targetParent = await this.requirePath(driverParentPath(to))
      if (!targetParent.isDir || targetParent.kind === 'root') throw DriverError.notFound('The destination folder was not found')
      await this.jsonRequest(this.driveUrl(`/api/v3/groups/${source.groupId}/files/batch/move`), {
        method: 'POST',
        body: { fileids: [source.fileId], target_groupid: targetParent.groupId, target_parentid: targetParent.fileId },
      })
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = this.mountPath(fromPath)
    const to = this.mountPath(toPath)
    if (from === to) return
    await this.withAuth(async () => {
      const source = await this.requirePath(from)
      if (source.kind === 'root' || source.kind === 'group') throw DriverError.unsupported('WPS groups cannot be copied')
      const targetName = driverFileName(to)
      const targetParent = await this.requirePath(driverParentPath(to))
      if (!targetParent.isDir || targetParent.kind === 'root') throw DriverError.notFound('The destination folder was not found')
      await this.jsonRequest(this.driveUrl(`/api/v3/groups/${source.groupId}/files/batch/copy`), {
        method: 'POST',
        body: {
          fileids: [source.fileId],
          groupid: source.groupId,
          target_groupid: targetParent.groupId,
          target_parentid: targetParent.fileId,
          duplicated_name_model: 1,
        },
      })
      if (source.name !== targetName) {
        const copied = await this.findChild(targetParent.groupId, targetParent.fileId, source.name)
        if (!copied) throw DriverError.upstream('WPS copied the file but the copy could not be found to rename')
        await this.jsonRequest(this.driveUrl(`/api/v3/groups/${targetParent.groupId}/files/${copied.id}`), {
          method: 'PUT',
          body: { fname: targetName },
        })
      }
    })
  }

  async remove(path: string): Promise<void> {
    const clean = this.mountPath(path)
    await this.withAuth(async () => {
      const node = await this.requirePath(clean)
      if (node.kind === 'root' || node.kind === 'group') throw DriverError.unsupported('WPS groups cannot be deleted')
      await this.jsonRequest(this.driveUrl(`/api/v3/groups/${node.groupId}/files/batch/delete`), {
        method: 'POST',
        body: { fileids: [node.fileId] },
      })
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.getGroups()
      return {
        ok: true,
        message: `${this.isPersonal() ? 'WPS Personal' : 'WPS Business'} drive is reachable`,
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      return { ok: false, message: error instanceof Error ? error.message : 'WPS is unavailable' }
    }
  }
}

export function createWpsDriver(ctx: DriverContext): MountDriver {
  return new WpsDriver(ctx)
}
