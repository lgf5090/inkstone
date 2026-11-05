/**
 * Google Photos driver.
 *
 * The Photos Library has no folder hierarchy: the mount root lists the account's media items and a
 * first-level path segment names an album. `mediaItems:search` is the only listing endpoint and it
 * paginates with a `pageToken`. Reads stream from the item's `baseUrl` with the `=d` suffix; the same
 * signed address is what the reference implementation returns as `raw_url`, so it is the direct link.
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
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'
import { OAuthSession } from './token'

const API = 'https://photoslibrary.googleapis.com/v1'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

interface GooglePhotoItem {
  id: string
  filename?: string
  baseUrl?: string
  mimeType?: string
  mediaMetadata?: { creationTime?: string }
}

interface GooglePhotoSearch {
  mediaItems?: GooglePhotoItem[]
  nextPageToken?: string
}

interface GooglePhotoAlbum {
  id: string
  title?: string
}

interface GooglePhotoAlbums {
  albums?: GooglePhotoAlbum[]
  nextPageToken?: string
}

function mediaEntry(item: GooglePhotoItem): DriverEntry {
  const name = item.filename || item.id
  return {
    name,
    kind: 'file',
    size: 0,
    modifiedAt: item.mediaMetadata?.creationTime ? Date.parse(item.mediaMetadata.creationTime) : 0,
    ref: item.id,
    mime: item.mimeType || driverEntryMime(name),
  }
}

export class GooglePhotoDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('google_photo')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'google_photo')
  private readonly albumIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
  }

  private async search(albumId: string | null, pageToken: string | null, pageSize: number): Promise<GooglePhotoSearch> {
    const body: Record<string, unknown> = { pageSize: Math.min(100, Math.max(1, pageSize)) }
    if (albumId) body.albumId = albumId
    if (pageToken) body.pageToken = pageToken
    return await this.session.withToken(async (token) => {
      const response = await this.request(`${API}/mediaItems:search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await response.json() as GooglePhotoSearch
    })
  }

  private async albumsPage(pageToken: string | null): Promise<GooglePhotoAlbums> {
    const params = new URLSearchParams({ pageSize: '50', fields: 'albums(id,title),nextPageToken' })
    if (pageToken) params.set('pageToken', pageToken)
    return await this.session.withToken(async (token) => {
      const response = await this.request(`${API}/albums?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      return await response.json() as GooglePhotoAlbums
    })
  }

  /** Resolves one folder segment (an album title) to its album id. */
  private async albumId(path: string): Promise<string> {
    const clean = driverPath(path)
    const cached = this.albumIds.get(clean)
    if (cached) return cached
    const name = driverFileName(clean)
    let pageToken: string | null = null
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const payload = await this.albumsPage(pageToken)
      const album = (payload.albums ?? []).find((candidate) => candidate.title === name)
      if (album) {
        this.albumIds.set(clean, album.id)
        return album.id
      }
      pageToken = payload.nextPageToken ?? null
      if (!pageToken) break
    }
    throw DriverError.notFound(`Google Photos album not found: ${name}`)
  }

  private async page(folderPath: string, pageNumber: number, pageSize: number): Promise<{ items: GooglePhotoItem[]; next: string | null }> {
    const albumId = folderPath === '/' ? null : await this.albumId(folderPath)
    let pageToken: string | null = null
    let current = 1
    for (;;) {
      const payload = await this.search(albumId, pageToken, pageSize)
      if (current === pageNumber) return { items: payload.mediaItems ?? [], next: payload.nextPageToken ?? null }
      if (!payload.nextPageToken || current >= MAX_LIST_PAGES) return { items: [], next: null }
      pageToken = payload.nextPageToken
      current++
    }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const pageSize = options.pageSize ?? PAGE_SIZE
    if (options.page !== undefined) {
      const result = await this.page(clean, Math.max(1, options.page), pageSize)
      return { entries: result.items.map(mediaEntry), cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ page }) => await this.page(clean, page, pageSize), {
      maxPages: MAX_LIST_PAGES,
    })
    let entries = collected.items.map(mediaEntry)
    if (options.search) {
      const needle = options.search.toLowerCase()
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    }
    return { entries, cursor: null, truncated: collected.truncated }
  }

  private async resolveItem(path: string): Promise<GooglePhotoItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parent = driverParentPath(clean)
    const name = driverFileName(clean)
    const collected = await collectPages(async ({ page }) => await this.page(parent, page, PAGE_SIZE), {
      maxPages: MAX_LIST_PAGES,
    })
    const item = collected.items.find((candidate) => (candidate.filename || candidate.id) === name)
    if (!item) throw DriverError.notFound(`Google Photos item not found: ${clean}`)
    return item
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'Photos', kind: 'folder', size: 0, modifiedAt: 0, ref: 'root' }
    }
    return mediaEntry(await this.resolveItem(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const item = await this.resolveItem(clean)
    const baseUrl = item.baseUrl
    if (!baseUrl) throw DriverError.notFound(`Google Photos returned no download address for ${clean}`)
    return await this.session.withToken(async (token) => {
      const response = await fetch(`${baseUrl}=d`, {
        headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Google Photos download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const item = await this.resolveItem(path)
    if (!item.baseUrl) return null
    return item.mimeType?.startsWith('video/') ? `${item.baseUrl}=dv` : `${item.baseUrl}=d`
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Google Photos is read only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Google Photos has no folders')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Google Photos cannot rename items')
  }

  async move(fromPath: string, _toPath: string): Promise<void> {
    driverPath(fromPath)
    throw DriverError.unsupported('Google Photos cannot move items')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Google Photos is read only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.page('/', 1, 1)
      return { ok: true, message: 'Google Photos is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Google Photos is unavailable' }
    }
  }
}

export function createGooglePhotoDriver(ctx: DriverContext): MountDriver {
  return new GooglePhotoDriver(ctx)
}
