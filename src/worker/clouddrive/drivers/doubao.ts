/**
 * Doubao cloud storage driver, cookie authenticated.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/doubao`: every call is a JSON POST and success
 * is `code === 0`, so an auth-shaped code forces one re-login and a retry before the storage is
 * marked for review. The node tree is only addressable by id, which is resolved segment by segment
 * and cached for the duration of one driver instance.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import { cloudDriveNameProblem } from '@shared/clouddrive/model'
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
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const BASE_URL = 'https://www.doubao.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DEFAULT_ROOT = '0'
const DIRECTORY_TYPE = 1
const VIDEO_TYPE = 6
const AUDIO_TYPE = 7
const MAX_PAGES = 50

const NODE_TYPE_NAME: Record<number, string> = {
  1: 'directory',
  2: 'file',
  3: 'link',
  4: 'image',
  5: 'pages',
  6: 'video',
  7: 'audio',
  8: 'meeting_minutes',
}

interface DoubaoNode {
  id: string
  name: string
  key: string
  node_type: number
  size?: number
  parent_id?: string
  update_time?: number
  create_time?: number
}

interface DoubaoResponse<T = unknown> {
  code?: number
  msg?: string
  message?: string
  data?: T
  error?: { code?: number; message?: string }
}

interface DoubaoChildren {
  children?: DoubaoNode[]
  next_cursor?: string
  has_more?: boolean
}

function nodeEntry(node: DoubaoNode): DriverEntry {
  const folder = node.node_type === DIRECTORY_TYPE
  return {
    name: node.name,
    kind: folder ? 'folder' : 'file',
    size: Number(node.size) || 0,
    modifiedAt: Number(node.update_time) ? Number(node.update_time) * 1000 : 0,
    ref: node.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(node.name),
  }
}

function isAuthMessage(message: string): boolean {
  return /unauthor|forbidden|auth|login|expired|not.?log.?in|token|\u767b\u5f55|\u672a\u6388\u6743|\u8fc7\u671f|\u6743\u9650/i.test(message)
}

function payloadError(payload: DoubaoResponse): DriverError {
  const message = payload.message || payload.msg || payload.error?.message || `Doubao answered code ${payload.code}`
  const code = Number(payload.code)
  if (code === 401 || code === 403 || isAuthMessage(message)) {
    return DriverError.auth(`Doubao refused the cookie: ${message}`)
  }
  if (code === 404 || /not.?found|\u4e0d\u5b58\u5728/i.test(message)) return DriverError.notFound(message)
  if (code === 429 || /rate|too.?many|\u9891\u7e41/i.test(message)) return DriverError.rateLimited(message)
  return DriverError.upstream(message)
}

class DoubaoDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('doubao')!
  readonly capabilities = this.definition.capabilities
  private cookie = ''
  private readonly pathIds = new Map<string, string>()

  private rootId(): string {
    return this.configText('rootFolderId', DEFAULT_ROOT).trim() || DEFAULT_ROOT
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Cookie: this.cookie,
      'User-Agent': USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      Accept: 'application/json',
    }
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.cookie) return
    const raw = this.ctx.credentials.cookie ?? ''
    if (!raw.trim()) throw DriverError.auth('Doubao needs a browser cookie')
    this.cookie = raw.trim()
  }

  private clean(path: string): string {
    return driverPath(path)
  }

  private async api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return await this.withAuth(async () => {
      const response = await this.request(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null) as DoubaoResponse<T> | null
      if (!payload) throw DriverError.upstream('Doubao returned an unreadable body')
      if (Number(payload.code) !== 0) throw payloadError(payload)
      return payload.data as T
    })
  }

  private async children(dirId: string, cursor: string | null, size: number): Promise<{ items: DoubaoNode[]; next: string | null }> {
    const body: Record<string, unknown> = { node_id: dirId, need_full_path: false, size }
    if (cursor) body.cursor = cursor
    const data = await this.api<DoubaoChildren>('/samantha/aispace/node_info', body)
    const next = data?.next_cursor && String(data.next_cursor) !== '-1' ? String(data.next_cursor) : null
    return { items: data?.children ?? [], next }
  }

  private async childrenPage(dirId: string, page: number, size: number): Promise<{ items: DoubaoNode[]; next: string | null }> {
    let cursor: string | null = null
    let current = 1
    for (;;) {
      const result = await this.children(dirId, cursor, size)
      if (current === page) return result
      if (!result.next) return { items: [], next: null }
      cursor = result.next
      current++
      if (current > MAX_PAGES) return { items: [], next: null }
    }
  }

  private async findChild(parentId: string, name: string): Promise<DoubaoNode | null> {
    let cursor: string | null = null
    let page = 1
    for (;;) {
      const result = await this.children(parentId, cursor, 50)
      const hit = result.items.find((node) => node.name === name)
      if (hit) return hit
      if (!result.next || page >= MAX_PAGES) return null
      cursor = result.next
      page++
    }
  }

  private async resolveDirId(path: string): Promise<string> {
    const clean = this.clean(path)
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached
    const segments = clean.split('/').filter(Boolean)
    let parent = this.rootId()
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const hit = await this.findChild(parent, segment)
      if (!hit || hit.node_type !== DIRECTORY_TYPE) throw DriverError.notFound(`Folder not found: ${segment}`)
      parent = hit.id
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveNode(path: string): Promise<{ node: DoubaoNode; parentId: string }> {
    const clean = this.clean(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveDirId(driverParentPath(clean))
    const node = await this.findChild(parentId, driverFileName(clean))
    if (!node) throw DriverError.notFound(`Not found: ${driverFileName(clean)}`)
    return { node, parentId }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const dirId = await this.resolveDirId(path)
    const pageSize = Math.max(1, options.pageSize ?? 50)
    if (options.page !== undefined) {
      const result = await this.childrenPage(dirId, Math.max(1, options.page), pageSize)
      return {
        entries: result.items.map(nodeEntry),
        cursor: result.next,
        truncated: result.next !== null,
      }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const result = await this.children(dirId, cursor, pageSize)
      return { items: result.items, next: result.next }
    }, { mode: 'cursor', maxPages: MAX_PAGES })
    return { entries: collected.items.map(nodeEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = this.clean(path)
    if (clean === '/') {
      return { name: '/', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId(), mime: 'application/octet-stream' }
    }
    const { node } = await this.resolveNode(clean)
    return nodeEntry(node)
  }

  private async downloadUrl(node: DoubaoNode): Promise<string> {
    const downloadApi = this.configText('downloadApi', 'get_file_url')
    if (downloadApi === 'get_download_info') {
      const data = await this.api<{ download_infos?: { main_url?: string }[] }>('/samantha/aispace/get_download_info', {
        requests: [{ node_id: node.id }],
      })
      const url = data?.download_infos?.[0]?.main_url ?? ''
      if (!url) throw DriverError.upstream('Doubao returned no download address')
      return url
    }
    if (node.node_type === VIDEO_TYPE || node.node_type === AUDIO_TYPE) {
      const data = await this.api<{
        original_media_info?: { main_url?: string }
        media_info?: { main_url?: string }[]
      }>('/samantha/media/get_play_info', { key: node.key, node_id: node.id })
      const url = data?.original_media_info?.main_url || data?.media_info?.[0]?.main_url || ''
      if (!url) throw DriverError.upstream('Doubao returned no download address')
      return url
    }
    const data = await this.api<{ file_urls?: { main_url?: string }[] }>('/alice/message/get_file_url', {
      uris: [node.key],
      type: NODE_TYPE_NAME[node.node_type] || 'file',
    })
    const url = data?.file_urls?.[0]?.main_url ?? ''
    if (!url) throw DriverError.upstream('Doubao returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const { node } = await this.resolveNode(path)
    if (node.node_type === DIRECTORY_TYPE) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadUrl(node)
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        ...(range ? { Range: range } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throwDownloadStatus(response.status)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const { node } = await this.resolveNode(path)
    if (node.node_type === DIRECTORY_TYPE) return null
    return await this.downloadUrl(node)
  }

  async upload(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Doubao does not expose an upload endpoint')
  }

  async mkdir(path: string): Promise<void> {
    const clean = this.clean(path)
    if (clean === '/') return
    const parentId = await this.resolveDirId(driverParentPath(clean))
    await this.api('/samantha/aispace/upload_node', {
      node_list: [{
        local_id: crypto.randomUUID(),
        name: driverFileName(clean),
        parent_id: parentId,
        node_type: DIRECTORY_TYPE,
      }],
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const problem = cloudDriveNameProblem(newName)
    if (problem) throw DriverError.invalid(problem)
    const clean = this.clean(path)
    const { node } = await this.resolveNode(clean)
    await this.api('/samantha/aispace/rename_node', { node_id: node.id, node_name: newName })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = this.clean(fromPath)
    const target = this.clean(toPath)
    const { node, parentId } = await this.resolveNode(from)
    const targetName = driverFileName(target)
    if (targetName !== node.name) await this.rename(from, targetName)
    const targetParentId = await this.resolveDirId(driverParentPath(target))
    await this.api('/samantha/aispace/move_node', {
      node_list: [{ id: node.id }],
      current_parent_id: node.parent_id || parentId,
      target_parent_id: targetParentId,
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const { node } = await this.resolveNode(path)
    await this.api('/samantha/aispace/delete_node', { node_list: [{ id: node.id }] })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.children(this.rootId(), null, 1)
      return { ok: true, message: 'Doubao is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Doubao is unavailable' }
    }
  }
}

function throwDownloadStatus(status: number): never {
  if (status === 401 || status === 403) throw DriverError.auth(`The download was refused (HTTP ${status})`)
  if (status === 404) throw DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) throw DriverError.rateLimited('The download was rate limited')
  throw DriverError.upstream(`The download answered HTTP ${status}`)
}

export function createDoubaoDriver(ctx: DriverContext): MountDriver {
  return new DoubaoDriver(ctx)
}
