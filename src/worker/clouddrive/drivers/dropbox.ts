/**
 * Dropbox driver.
 *
 * Dropbox splits its API in two hosts: RPC endpoints under `api.dropboxapi.com` carry JSON, content
 * endpoints under `content.dropboxapi.com` carry the bytes plus a `Dropbox-API-Arg` header. The mount
 * root maps to Dropbox's empty path `""`. Uploads use the single-shot endpoint up to 150 MB and a
 * session above that.
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

const RPC = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const SIMPLE_UPLOAD_LIMIT = 150 * 1024 * 1024
const SESSION_CHUNK = 8 * 1024 * 1024
const MAX_LIST_PAGES = 50

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted'
  name: string
  path_display?: string
  size?: number
  client_modified?: string
  server_modified?: string
}

interface DropboxList {
  entries: DropboxEntry[]
  cursor: string
  has_more: boolean
}

function mountRoot(path: string): string {
  return path === '/' ? '' : path
}

function entryOf(entry: DropboxEntry): DriverEntry {
  const folder = entry['.tag'] === 'folder'
  return {
    name: entry.name,
    kind: folder ? 'folder' : 'file',
    size: Number(entry.size) || 0,
    modifiedAt: Date.parse(entry.server_modified ?? entry.client_modified ?? '') || 0,
    ref: entry.path_display ?? '',
    mime: folder ? 'application/octet-stream' : driverEntryMime(entry.name),
  }
}

export class DropboxDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('dropbox')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'dropbox')

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
    await this.rpc('users/get_current_account', {})
  }

  private async rpc<T>(route: string, body: Record<string, unknown>): Promise<T> {
    return await this.session.withToken(async (token) => {
      let response: Response
      try {
        response = await fetch(`${RPC}/${route}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        throw DriverError.upstream(`Dropbox could not be reached: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (response.status === 429) throw DriverError.rateLimited('Dropbox is rate limiting requests')
      if (response.status === 401) throw DriverError.auth('Dropbox rejected the access token')
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (response.status === 409 && text.includes('not_found')) {
          throw DriverError.notFound(`Dropbox could not find the item: ${text.slice(0, 120)}`)
        }
        throw DriverError.upstream(`Dropbox answered HTTP ${response.status}: ${text.slice(0, 160)}`)
      }
      if (response.status === 204) return undefined as T
      return await response.json() as T
    })
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const root = mountRoot(driverPath(path))
    let cursor: string | null = null
    const first = await this.rpc<DropboxList>('files/list_folder', { path: root, recursive: false })
    let current = first
    let page = 1
    const target = options.page === undefined ? null : Math.max(1, options.page)
    while (target !== null && page < target && current.has_more) {
      current = await this.rpc<DropboxList>('files/list_folder/continue', { cursor: current.cursor })
      page++
    }
    cursor = current.cursor
    const entries = current.entries
    if (target !== null) {
      return { entries: entries.map(entryOf), cursor: current.has_more ? cursor : null, truncated: current.has_more }
    }
    const collected = await collectPages(async (state) => {
      if (state.page === 1) return { items: first.entries, next: first.has_more ? first.cursor : null }
      const next = await this.rpc<DropboxList>('files/list_folder/continue', { cursor: state.cursor ?? first.cursor })
      return { items: next.entries, next: next.has_more ? next.cursor : null }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let output = collected.items.map(entryOf)
    if (options.search) {
      const needle = options.search.toLowerCase()
      output = output.filter((entry) => entry.name.toLowerCase().includes(needle))
    }
    return { entries: output, cursor: null, truncated: collected.truncated }
  }

  private async metadata(path: string): Promise<DropboxEntry> {
    return await this.rpc<DropboxEntry>('files/get_metadata', { path: mountRoot(driverPath(path)) })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    return entryOf(await this.metadata(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.session.withToken(async (token) => {
      const response = await fetch(`${CONTENT}/files/download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: mountRoot(clean) }),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Dropbox download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') return null
    const payload = await this.rpc<{ link: string }>('files/get_temporary_link', { path: mountRoot(clean) })
    return payload.link || null
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const clean = driverPath(path)
    const arg = {
      path: mountRoot(clean),
      mode: 'add',
      autorename: true,
      mute: false,
    }
    if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      await this.contentCall('files/upload', arg, bytes)
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const start = await this.contentCall<{ session_id: string }>('files/upload_session/start', { close: false }, bytes.subarray(0, SESSION_CHUNK))
    let offset = SESSION_CHUNK
    options.onProgress?.(offset, bytes.byteLength)
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + SESSION_CHUNK, bytes.byteLength)
      await this.contentCall('files/upload_session/append_v2', {
        cursor: { session_id: start.session_id, offset },
        close: false,
      }, bytes.subarray(offset, end))
      offset = end
      options.onProgress?.(offset, bytes.byteLength)
    }
    await this.contentCall('files/upload_session/finish', {
      cursor: { session_id: start.session_id, offset: bytes.byteLength },
      commit: arg,
    }, undefined)
  }

  private async contentCall<T>(route: string, arg: Record<string, unknown>, body: Uint8Array | undefined): Promise<T> {
    return await this.session.withToken(async (token) => {
      const response = await fetch(`${CONTENT}/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': JSON.stringify(arg),
          ...(body === undefined ? {} : { 'Content-Type': 'application/octet-stream' }),
        },
        body: body as BodyInit | undefined,
        signal: AbortSignal.timeout(60_000),
      })
      if (response.status === 401) throw DriverError.auth('Dropbox rejected the access token')
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw DriverError.upstream(`Dropbox content call failed (HTTP ${response.status}): ${text.slice(0, 160)}`)
      }
      if (response.status === 204) return undefined as T
      const text = await response.text()
      return (text ? JSON.parse(text) : undefined) as T
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.rpc('files/create_folder_v2', { path: mountRoot(clean), autorename: false })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    await this.rpc('files/move_v2', {
      from_path: mountRoot(clean),
      to_path: mountRoot(`${driverParentPath(clean)}/${newName}`),
      autorename: false,
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.rpc('files/move_v2', {
      from_path: mountRoot(driverPath(fromPath)),
      to_path: mountRoot(driverPath(toPath)),
      autorename: false,
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.rpc('files/copy_v2', {
      from_path: mountRoot(driverPath(fromPath)),
      to_path: mountRoot(driverPath(toPath)),
      autorename: false,
    })
  }

  async remove(path: string): Promise<void> {
    await this.rpc('files/delete_v2', { path: mountRoot(driverPath(path)) })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const account = await this.rpc<{ name?: string; email?: string }>('users/get_current_account', {})
      return { ok: true, message: `Dropbox is reachable${account.email ? ` · ${account.email}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Dropbox is unavailable' }
    }
  }
}

export function createDropboxDriver(ctx: DriverContext): MountDriver {
  return new DropboxDriver(ctx)
}

export { driverFileName }
