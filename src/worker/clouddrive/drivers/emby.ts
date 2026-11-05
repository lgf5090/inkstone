/**
 * Emby driver: read-only browsing of an Emby media library.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/emby`: `/Users/{userId}/Items` listings,
 * `/Items/{id}/Download` for the download link method and `/Videos/{id}/stream` for the stream
 * method. Emby has no pagination and is read-only, so the write methods are absent by design.
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

const EMBY_AUTHORIZATION =
  'MediaBrowser Client="Inkstone", Device="Inkstone", DeviceId="inkstone-clouddrive", Version="1.0.0"'

interface EmbyItem {
  Name: string
  Id: string
  Type?: string
  Path?: string
  IsFolder?: boolean
  Size?: number
  DateCreated?: string
}

interface EmbyList {
  Items?: EmbyItem[]
  TotalRecordCount?: number
}

interface EmbyMediaSource {
  Id?: string
  Container?: string
  SupportsDirectStream?: boolean
}

interface EmbyItemDetail {
  MediaSources?: EmbyMediaSource[]
}

interface EmbyAuth {
  AccessToken?: string
  User?: { Id?: string }
}

function itemEntry(item: EmbyItem): DriverEntry {
  const folder = item.IsFolder === true
  return {
    name: item.Name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(item.Size) || 0,
    modifiedAt: Date.parse(item.DateCreated ?? '') || 0,
    ref: item.Id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(item.Name),
  }
}

class EmbyDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('emby')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private userId: string
  private readonly idCache = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = ctx.credentials.apiKey ?? ''
    this.userId = this.configText('userId') || ctx.credentials.userId || ''
  }

  private baseUrl(): string {
    const raw = this.configText('url').trim()
    if (!raw) throw DriverError.invalid('Emby needs a server URL')
    return raw.replace(/\/+$/, '')
  }

  private rootFolderId(): string {
    return this.configText('rootFolderId').trim() || '1'
  }

  private linkMethod(): string {
    return (this.configText('linkMethod', 'stream').trim() || 'stream').toLowerCase()
  }

  protected async login(force: boolean): Promise<void> {
    const apiKey = (this.ctx.credentials.apiKey ?? '').trim()
    const username = this.configText('username').trim()
    const password = this.ctx.credentials.password ?? ''
    if (!force && apiKey && this.userId) {
      this.token = apiKey
      return
    }
    if (!username) {
      if (!apiKey) throw DriverError.auth('Emby needs an API key and a user id, or a username and a password')
      throw DriverError.auth('Emby needs a user id alongside the API key')
    }
    const data = await this.signIn(username, password)
    this.token = data.AccessToken!
    this.userId = data.User!.Id!
    await this.saveCredential({ apiKey: this.token, userId: this.userId })
  }

  private async signIn(username: string, password: string): Promise<EmbyAuth> {
    const response = await this.request(`${this.baseUrl()}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Emby-Authorization': EMBY_AUTHORIZATION,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    const data = await response.json().catch(() => null) as EmbyAuth | null
    if (!data?.AccessToken || !data.User?.Id) {
      throw DriverError.auth('Emby did not return an access token and a user id')
    }
    return data
  }

  private async getItems(parentId: string): Promise<EmbyItem[]> {
    const query = new URLSearchParams({
      ParentId: parentId,
      Recursive: 'false',
      Fields: 'Path,Size,DateCreated,SeriesName,IndexNumber,ParentIndexNumber',
      api_key: this.token,
    })
    const data = await this.json<EmbyList>(
      `${this.baseUrl()}/Users/${encodeURIComponent(this.userId)}/Items?${query.toString()}`,
    )
    return data?.Items ?? []
  }

  private async resolveId(logical: string): Promise<string> {
    const clean = driverPath(logical)
    if (clean === '/') return this.rootFolderId()
    const cached = this.idCache.get(clean)
    if (cached) return cached
    const segments = clean.split('/').filter(Boolean)
    let currentId = this.rootFolderId()
    let currentPath = ''
    for (const segment of segments) {
      const items = await this.getItems(currentId)
      const hit = items.find((item) => item.Name === segment && item.IsFolder === true)
      if (!hit) throw DriverError.notFound(`Emby folder not found: ${segment}`)
      currentId = hit.Id
      currentPath = currentPath === '' ? `/${segment}` : `${currentPath}/${segment}`
      this.idCache.set(currentPath, currentId)
    }
    return currentId
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const logical = driverPath(path)
    const entries = await this.withAuth(async () => {
      const parentId = await this.resolveId(logical)
      const items = await this.getItems(parentId)
      for (const item of items) {
        this.idCache.set(logical === '/' ? `/${item.Name}` : `${logical}/${item.Name}`, item.Id)
      }
      return items.map(itemEntry)
    })
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const logical = driverPath(path)
    if (logical === '/') {
      return {
        name: '/',
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: this.rootFolderId(),
      }
    }
    const name = driverFileName(logical)
    const parentId = await this.withAuth(async () => await this.resolveId(driverParentPath(logical)))
    const items = await this.withAuth(async () => await this.getItems(parentId))
    const hit = items.find((item) => item.Name === name)
    if (!hit) throw DriverError.notFound(`Emby entry not found: ${name}`)
    this.idCache.set(logical, hit.Id)
    return itemEntry(hit)
  }

  private async buildLink(itemId: string): Promise<string> {
    const useDownload = this.linkMethod() === 'download'
    let mediaSourceId = ''
    let container = ''
    if (!useDownload) {
      try {
        const query = new URLSearchParams({ Fields: 'MediaSources', api_key: this.token })
        const detail = await this.json<EmbyItemDetail>(
          `${this.baseUrl()}/Users/${encodeURIComponent(this.userId)}/Items/${encodeURIComponent(itemId)}?${query.toString()}`,
        )
        const preferred = detail.MediaSources?.find((source) => source.Id && source.SupportsDirectStream)
          ?? detail.MediaSources?.find((source) => source.Id)
        if (preferred) {
          mediaSourceId = preferred.Id ?? ''
          container = preferred.Container ?? ''
        }
      } catch {
        // The stream link still works without a media source; the reference ignores this failure too.
      }
    }
    const url = new URL(this.baseUrl())
    const basePath = url.pathname.replace(/\/+$/, '')
    if (useDownload) {
      url.pathname = `${basePath}/Items/${encodeURIComponent(itemId)}/Download`
    } else if (container) {
      url.pathname = `${basePath}/Videos/${encodeURIComponent(itemId)}/stream.${container}`
    } else {
      url.pathname = `${basePath}/Videos/${encodeURIComponent(itemId)}/stream`
    }
    url.searchParams.set('api_key', this.token)
    if (mediaSourceId) url.searchParams.set('MediaSourceId', mediaSourceId)
    if (!useDownload) url.searchParams.set('Static', 'true')
    return url.toString()
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    if (!entry.ref) throw DriverError.upstream('Emby returned no item id')
    const link = await this.withAuth(async () => await this.buildLink(entry.ref!))
    return await this.request(link, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder' || !entry.ref) return null
    return await this.withAuth(async () => await this.buildLink(entry.ref!))
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const items = await this.withAuth(async () => await this.getItems(this.rootFolderId()))
      return { ok: true, message: `Emby is reachable · ${items.length} items` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Emby is unavailable' }
    }
  }

  // Emby is read-only; the write operations are intentionally absent (undefined at runtime).
  declare readonly upload: MountDriver['upload']
  declare readonly mkdir: MountDriver['mkdir']
  declare readonly rename: MountDriver['rename']
  declare readonly move: MountDriver['move']
  declare readonly remove: MountDriver['remove']
}

export function createEmbyDriver(ctx: DriverContext): MountDriver {
  return new EmbyDriver(ctx)
}
