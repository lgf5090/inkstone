/**
 * TelDrive driver: a self-hosted Telegram drive behind a Bearer JWT.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/teldrive`: `/api/files` listing by path,
 * `/api/files/{id}` download, `mkdir`, `move` and `DELETE /api/files/{id}` removal. Renaming is not
 * exposed by the reference API, and a direct upload needs a resumable session, so both stay absent.
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

interface TeldriveFile {
  id: string
  name: string
  type?: string
  mimeType?: string
  size?: number
  parentId?: string
  createdAt?: string
  updatedAt?: string
}

interface TeldriveList {
  files?: TeldriveFile[]
}

function fileEntry(file: TeldriveFile): DriverEntry {
  const folder = file.type === 'folder'
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: Date.parse(file.updatedAt ?? file.createdAt ?? '') || 0,
    ref: file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

class TeldriveDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('teldrive')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = ctx.credentials.accessToken ?? ''
  }

  private baseUrl(): string {
    const raw = this.configText('url').trim()
    if (!raw) throw DriverError.invalid('TelDrive needs a server URL')
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

  private headers(): Record<string, string> {
    return { Accept: 'application/json', Authorization: `Bearer ${this.token}` }
  }

  protected async login(): Promise<void> {
    const token = (this.ctx.credentials.accessToken ?? '').trim()
    if (!token) throw DriverError.auth('TelDrive needs an access token')
    this.token = token
  }

  private async listFiles(physical: string): Promise<TeldriveFile[]> {
    const query = new URLSearchParams({ path: physical })
    const data = await this.json<TeldriveFile[] | TeldriveList>(
      `${this.baseUrl()}/api/files?${query.toString()}`,
      { headers: this.headers() },
    )
    if (Array.isArray(data)) return data
    return data?.files ?? []
  }

  private async resolveFolderId(physical: string): Promise<string> {
    const clean = physical === '/' ? '' : physical
    if (!clean) return '/'
    const cached = this.pathIds.get(clean)
    if (cached) return cached
    const parts = clean.split('/').filter(Boolean)
    let currentPhysical = ''
    let currentId = '/'
    for (const part of parts) {
      const files = await this.listFiles(currentPhysical === '' ? '/' : currentPhysical)
      const hit = files.find((file) => file.name === part && file.type === 'folder')
      if (!hit) throw DriverError.notFound(`TelDrive folder not found: ${part}`)
      currentPhysical = `${currentPhysical}/${part}`
      currentId = hit.id
      this.pathIds.set(currentPhysical, currentId)
    }
    return currentId
  }

  private async resolveEntry(physical: string): Promise<{ entry: TeldriveFile; isDir: boolean }> {
    if (physical === '/') throw DriverError.notFound('The root is not a single entry')
    const parent = driverParentPath(physical)
    const name = driverFileName(physical)
    const files = await this.listFiles(parent)
    const hit = files.find((file) => file.name === name)
    if (!hit) throw DriverError.notFound(`TelDrive entry not found: ${name}`)
    return { entry: hit, isDir: hit.type === 'folder' }
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const physical = this.physical(path)
    const files = await this.withAuth(async () => await this.listFiles(physical))
    return { entries: files.map(fileEntry), cursor: null, truncated: false }
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
        ref: physical === '/' ? undefined : physical,
      }
    }
    const { entry } = await this.withAuth(async () => await this.resolveEntry(physical))
    return fileEntry(entry)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const physical = this.physical(path)
    const { entry, isDir } = await this.withAuth(async () => await this.resolveEntry(physical))
    if (isDir) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = `${this.baseUrl()}/api/files/${encodeURIComponent(entry.id)}`
    return await this.request(link, {
      headers: { Authorization: `Bearer ${this.token}`, ...(range ? { Range: range } : {}) },
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const { entry, isDir } = await this.withAuth(async () => await this.resolveEntry(this.physical(path)))
    if (isDir) return null
    return `${this.baseUrl()}/api/files/${encodeURIComponent(entry.id)}`
  }

  async mkdir(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') return
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      await this.json(`${this.baseUrl()}/api/files/mkdir`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: physical }),
      })
    })
    this.pathIds.delete(physical)
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
      throw DriverError.unsupported('TelDrive cannot rename an entry while moving it')
    }
    await this.withAuth(async () => {
      const { entry } = await this.resolveEntry(fromPhysical)
      const destination = await this.resolveFolderId(driverParentPath(toPhysical))
      await this.json(`${this.baseUrl()}/api/files/move`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [entry.id], destination }),
      })
    })
    this.pathIds.delete(fromPhysical)
    this.pathIds.delete(toPhysical)
  }

  async remove(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') throw DriverError.invalid('The mount root cannot be removed')
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      const { entry } = await this.resolveEntry(physical)
      const response = await this.request(`${this.baseUrl()}/api/files/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        headers: this.headers(),
      })
      await response.body?.cancel().catch(() => undefined)
    })
    this.pathIds.delete(physical)
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.list('/')
      return { ok: true, message: 'TelDrive is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'TelDrive is unavailable' }
    }
  }

  // A direct upload needs a resumable session and renaming has no endpoint.
  declare readonly upload: MountDriver['upload']
  declare readonly rename: MountDriver['rename']
}

export function createTeldriveDriver(ctx: DriverContext): MountDriver {
  return new TeldriveDriver(ctx)
}
