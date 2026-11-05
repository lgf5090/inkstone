/**
 * Yandex Disk driver.
 *
 * Paths are absolute (`/photos`). Listing is offset based; downloads and uploads are two-step: ask
 * `resources/download|upload` for a short-lived href, then stream against that href. The temporary
 * download href is what `directLink` returns.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import { HttpDriverBase, collectPages, driverFileName, driverParentPath, driverPath } from './http'
import { OAuthSession } from './token'

const API = 'https://cloud-api.yandex.net/v1/disk/resources'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

interface YandexItem {
  name: string
  type: 'dir' | 'file'
  size?: number
  modified?: string
  path?: string
  resource_id?: string
  mime_type?: string
}

interface YandexList {
  _embedded?: { items?: YandexItem[]; total?: number }
}

function itemOf(item: YandexItem): DriverEntry {
  const folder = item.type === 'dir'
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: Number(item.size) || 0,
    modifiedAt: item.modified ? Date.parse(item.modified) : 0,
    ref: item.path,
    mime: folder ? 'application/octet-stream' : (item.mime_type || driverEntryMime(item.name)),
  }
}

export class YandexDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('yandex')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'yandex')

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
    await this.stat('/')
  }

  private async api<T>(
    path: string,
    options: { method?: string; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${API}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    return await this.session.withToken(async (token) => {
      const response = await this.request(url.toString(), {
        method: (options.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (response.status === 204) return undefined as T
      return await response.json() as T
    })
  }

  private fields(): string {
    return 'name,type,size,modified,path,resource_id,mime_type'
  }

  private async page(path: string, pageNumber: number, pageSize: number): Promise<{ items: YandexItem[]; next: string | null }> {
    const offset = (pageNumber - 1) * pageSize
    const payload = await this.api<YandexList>('', {
      query: {
        path: driverPath(path),
        limit: String(pageSize),
        offset: String(offset),
        fields: `_embedded.items(${this.fields()}),_embedded.total`,
      },
    })
    const items = payload._embedded?.items ?? []
    const total = payload._embedded?.total ?? 0
    const next = offset + items.length < total ? String(offset + items.length) : null
    return { items, next }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const pageSize = options.pageSize ?? PAGE_SIZE
    if (options.page !== undefined) {
      const result = await this.page(clean, Math.max(1, options.page), pageSize)
      return { entries: result.items.map(itemOf), cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ page }) => await this.page(clean, page, pageSize), {
      mode: 'cursor',
      maxPages: MAX_LIST_PAGES,
    })
    let entries = collected.items.map(itemOf)
    if (options.search) {
      const needle = options.search.toLowerCase()
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    }
    return { entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const payload = await this.api<YandexItem>('', { query: { path: clean, fields: this.fields() } })
    if (!payload?.name) throw DriverError.notFound(`Yandex Disk could not resolve ${path}`)
    return itemOf(payload)
  }

  private async downloadHref(path: string): Promise<string> {
    const payload = await this.api<{ href?: string }>('/download', { query: { path: driverPath(path) } })
    if (!payload.href) throw DriverError.notFound(`Yandex Disk returned no download href for ${path}`)
    return payload.href
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const href = await this.downloadHref(path)
    const response = await fetch(href, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Yandex Disk download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.downloadHref(path)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const clean = driverPath(path)
    const target = await this.session.withToken(async (token) => {
      const response = await this.request(`${API}/upload?path=${encodeURIComponent(clean)}&overwrite=true`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      return await response.json() as { href?: string; method?: string }
    })
    if (!target.href) throw DriverError.upstream('Yandex Disk returned no upload href')
    const response = await fetch(target.href, {
      method: target.method ?? 'PUT',
      headers: { 'Content-Type': options.contentType ?? 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Yandex Disk upload failed (HTTP ${response.status})`)
    }
    await response.body?.cancel().catch(() => undefined)
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const response = await this.session.withToken(async (token) => await this.request(
      `${API}?path=${encodeURIComponent(clean)}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` } },
    ))
    await response.body?.cancel().catch(() => undefined)
  }

  async rename(path: string, newName: string): Promise<void> {
    await this.move(path, `${driverParentPath(driverPath(path))}/${newName}`)
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.api('/move', {
      method: 'POST',
      query: { from, path: to, overwrite: 'true' },
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.api('/copy', {
      method: 'POST',
      query: { from: driverPath(fromPath), path: driverPath(toPath), overwrite: 'true' },
    })
  }

  async remove(path: string): Promise<void> {
    const response = await this.session.withToken(async (token) => await this.request(
      `${API}?path=${encodeURIComponent(driverPath(path))}&permanently=false`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    await response.body?.cancel().catch(() => undefined)
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const root = await this.stat('/')
      return { ok: true, message: `Yandex Disk is reachable · ${root.name || '/'}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Yandex Disk is unavailable' }
    }
  }
}

export function createYandexDriver(ctx: DriverContext): MountDriver {
  return new YandexDriver(ctx)
}

export { driverFileName }
