/**
 * Misskey driver: the Misskey drive API.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/misskey`: `/api/drive/files` and
 * `/api/drive/folders` listings, `folders/create`, `folders/update`, `folders/delete`,
 * `files/update`, `files/delete` and `files/show` for a download address. Misskey's drive has no
 * pagination, and the reference does not implement a multipart upload, so `upload` stays absent.
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

interface MisskeyFile {
  id: string
  name: string
  size?: number
  createdAt?: string
  url?: string
  thumbnailUrl?: string
}

interface MisskeyFolder {
  id: string
  name: string
  createdAt?: string
}

function fileEntry(file: MisskeyFile): DriverEntry {
  return {
    name: file.name,
    kind: 'file',
    size: Number(file.size) || 0,
    modifiedAt: Date.parse(file.createdAt ?? '') || 0,
    ref: file.id,
    mime: driverEntryMime(file.name),
  }
}

function folderEntry(folder: MisskeyFolder): DriverEntry {
  return {
    name: folder.name,
    kind: 'folder',
    size: 0,
    modifiedAt: Date.parse(folder.createdAt ?? '') || 0,
    ref: folder.id,
  }
}

class MisskeyDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('misskey')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private readonly folderIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = ctx.credentials.accessToken ?? ''
  }

  private endpoint(): string {
    const raw = this.configText('endpoint').trim()
    if (!raw) throw DriverError.invalid('Misskey needs an endpoint')
    return raw.replace(/\/+$/, '')
  }

  private root(): string {
    const raw = this.configText('rootPath', '/').trim() || '/'
    try {
      return driverPath(raw)
    } catch {
      throw DriverError.invalid('The configured root path is invalid')
    }
  }

  private physical(path: string): string {
    const clean = driverPath(path)
    const root = this.root()
    if (root === '/') return clean
    return clean === '/' ? root : `${root}${clean}`
  }

  protected async login(): Promise<void> {
    const token = (this.ctx.credentials.accessToken ?? '').trim()
    if (!token) throw DriverError.auth('Misskey needs an access token')
    this.token = token
  }

  private async post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return await this.json<T>(`${this.endpoint()}/api/drive${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    })
  }

  private async getFiles(folderId?: string): Promise<MisskeyFile[]> {
    return await this.post<MisskeyFile[]>('/files', folderId ? { folderId } : {})
  }

  private async getFolders(folderId?: string): Promise<MisskeyFolder[]> {
    return await this.post<MisskeyFolder[]>('/folders', folderId ? { folderId } : {})
  }

  private async showFile(fileId: string): Promise<MisskeyFile> {
    return await this.post<MisskeyFile>('/files/show', { fileId })
  }

  private async resolveFolderId(physical: string): Promise<string | undefined> {
    const clean = physical === '/' ? '' : physical
    if (!clean) return undefined
    const cached = this.folderIds.get(clean)
    if (cached) return cached
    const parts = clean.split('/').filter(Boolean)
    let currentId: string | undefined
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      const folders = await this.getFolders(currentId)
      const hit = folders.find((folder) => folder.name === part)
      if (!hit) throw DriverError.notFound(`Misskey folder not found: ${part}`)
      currentId = hit.id
      this.folderIds.set(`/${parts.slice(0, index + 1).join('/')}`, hit.id)
    }
    return currentId
  }

  private async resolveEntry(physical: string): Promise<{ id: string; isDir: boolean; file?: MisskeyFile }> {
    if (physical === '/') throw DriverError.notFound('The root is not a single entry')
    const name = driverFileName(physical)
    const parentId = await this.resolveFolderId(driverParentPath(physical))
    const [files, folders] = await Promise.all([this.getFiles(parentId), this.getFolders(parentId)])
    const file = files.find((item) => item.name === name)
    if (file) return { id: file.id, isDir: false, file }
    const folder = folders.find((item) => item.name === name)
    if (folder) return { id: folder.id, isDir: true }
    throw DriverError.notFound(`Misskey entry not found: ${name}`)
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const physical = this.physical(path)
    const listing = await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(physical)
      const [files, folders] = await Promise.all([this.getFiles(folderId), this.getFolders(folderId)])
      return { files, folders }
    })
    return {
      entries: [...listing.folders.map(folderEntry), ...listing.files.map(fileEntry)],
      cursor: null,
      truncated: false,
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const logical = driverPath(path)
    const physical = this.physical(logical)
    if (logical === '/') {
      return {
        name: physical === '/' ? '/' : driverFileName(physical),
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
      }
    }
    const resolved = await this.withAuth(async () => await this.resolveEntry(physical))
    return resolved.isDir
      ? { name: driverFileName(physical), kind: 'folder', size: 0, modifiedAt: 0, ref: resolved.id }
      : fileEntry(resolved.file!)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const physical = this.physical(path)
    const resolved = await this.withAuth(async () => await this.resolveEntry(physical))
    if (resolved.isDir) throw DriverError.unsupported('A folder cannot be read as a file')
    const file = await this.withAuth(async () => await this.showFile(resolved.id))
    const link = (file.url ?? '').trim()
    if (!link) throw DriverError.upstream('Misskey returned no download address')
    return await this.request(link, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const resolved = await this.withAuth(async () => await this.resolveEntry(this.physical(path)))
    if (resolved.isDir) return null
    const file = await this.withAuth(async () => await this.showFile(resolved.id))
    return (file.url ?? '').trim() || null
  }

  async mkdir(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') return
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(physical))
      await this.post<MisskeyFolder>('/folders/create', {
        name: driverFileName(physical),
        ...(parentId ? { parentId } : {}),
      })
    })
    this.folderIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') throw DriverError.invalid('The mount root cannot be renamed')
    if (!newName || newName.includes('/') || newName.includes('\\')) {
      throw DriverError.invalid('The new name is invalid')
    }
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      const resolved = await this.resolveEntry(physical)
      if (resolved.isDir) await this.post('/folders/update', { folderId: resolved.id, name: newName })
      else await this.post('/files/update', { fileId: resolved.id, name: newName })
    })
    this.folderIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const fromLogical = driverPath(fromPath)
    const toLogical = driverPath(toPath)
    if (fromLogical === '/' || toLogical === '/') {
      throw DriverError.invalid('The mount root cannot be moved')
    }
    const fromPhysical = this.physical(fromLogical)
    const toPhysical = this.physical(toLogical)
    if (driverFileName(toPhysical) !== driverFileName(fromPhysical)) {
      throw DriverError.unsupported('Misskey cannot rename an entry while moving it')
    }
    await this.withAuth(async () => {
      const resolved = await this.resolveEntry(fromPhysical)
      const destination = await this.resolveFolderId(driverParentPath(toPhysical))
      if (resolved.isDir) {
        await this.post('/folders/update', { folderId: resolved.id, parentId: destination ?? null })
      } else {
        await this.post('/files/update', { fileId: resolved.id, folderId: destination ?? null })
      }
    })
    this.folderIds.clear()
  }

  async remove(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') throw DriverError.invalid('The mount root cannot be removed')
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      const resolved = await this.resolveEntry(physical)
      if (resolved.isDir) await this.post('/folders/delete', { folderId: resolved.id })
      else await this.post('/files/delete', { fileId: resolved.id })
    })
    this.folderIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.list('/')
      return { ok: true, message: 'Misskey is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Misskey is unavailable' }
    }
  }

  // The reference sends a multipart `drive/files/create` upload, which is not ported.
  declare readonly upload: MountDriver['upload']
}

export function createMisskeyDriver(ctx: DriverContext): MountDriver {
  return new MisskeyDriver(ctx)
}
