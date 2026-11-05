/**
 * IPFS node API driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/ipfs_api`:
 * `ipfs` and `ipns` mounts browse an immutable DAG through `/api/v0/ls`, while `mfs` mounts browse
 * and mutate the node's mutable filesystem through `/api/v0/files/*`. Downloads are always served
 * from the configured gateway as `/ipfs/<cid>` so a Range request reaches the gateway untouched.
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
import {
  HttpDriverBase,
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_PREFIX = '/api/v0'
type IpfsMode = 'ipfs' | 'ipns' | 'mfs'

interface IpfsLink {
  Name?: string
  Hash?: string
  Size?: number
  Type?: number
}

interface IpfsLsResponse {
  Objects?: Array<{ Hash?: string; Links?: IpfsLink[] }>
}

interface IpfsFilesEntry {
  Name?: string
  Hash?: string
  Size?: number
  Type?: number
}

interface IpfsFilesLsResponse {
  Entries?: IpfsFilesEntry[]
}

interface IpfsAddResponse {
  Hash?: string
}

class IpfsApiDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('ipfs_api')!
  readonly capabilities = this.definition.capabilities
  private endpoint = ''
  private gateway = ''
  private mode: IpfsMode = 'ipfs'
  private rootPath = '/'

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    const endpoint = this.configText('endpoint').trim().replace(/\/+$/, '')
    const gateway = this.configText('gateway').trim().replace(/\/+$/, '')
    if (!endpoint) throw DriverError.invalid('IPFS needs an endpoint (for example http://127.0.0.1:5001)')
    if (!gateway) throw DriverError.invalid('IPFS needs a gateway address')
    const rawMode = this.configText('mode', 'ipfs').trim().toLowerCase()
    if (rawMode !== 'ipfs' && rawMode !== 'ipns' && rawMode !== 'mfs') {
      throw DriverError.invalid(`IPFS mode must be ipfs, ipns or mfs, not "${rawMode}"`)
    }
    this.endpoint = endpoint
    this.gateway = gateway
    this.mode = rawMode
    this.rootPath = driverPath(this.configText('rootPath') || '/')
  }

  private apiUrl(endpoint: string, args: string[], params: Record<string, string> = {}): string {
    const query = new URLSearchParams()
    for (const arg of args) query.append('arg', arg)
    for (const [key, value] of Object.entries(params)) query.set(key, value)
    const search = query.toString()
    return `${this.endpoint}${API_PREFIX}/${endpoint}${search ? `?${search}` : ''}`
  }

  private async filesLs(path: string): Promise<IpfsFilesLsResponse> {
    return await this.json<IpfsFilesLsResponse>(this.apiUrl('files/ls', [path]), { method: 'POST' })
  }

  private async ls(path: string): Promise<IpfsLsResponse> {
    return await this.json<IpfsLsResponse>(this.apiUrl('ls', [path]), { method: 'POST' })
  }

  private async call(endpoint: string, args: string[], params: Record<string, string> = {}): Promise<void> {
    const response = await this.request(this.apiUrl(endpoint, args, params), { method: 'POST' })
    await response.body?.cancel().catch(() => undefined)
  }

  private mountPath(path: string): string {
    if (this.rootPath === '/') return path
    return path === '/' ? this.rootPath : `${this.rootPath}${path}`
  }

  /** The `/ipfs/<cid>` or `/ipns/<name>` path an immutable or mutable root resolves to. */
  private contentPath(path: string): string {
    const full = this.mountPath(path)
    const rest = full === '/' ? '' : full.slice(1)
    if (!rest) throw DriverError.invalid('An ipfs or ipns mount needs a rootPath naming a CID or an IPNS name')
    return this.mode === 'ipns' ? `/ipns/${rest}` : `/ipfs/${rest}`
  }

  private entryFromFile(entry: IpfsFilesEntry): DriverEntry | null {
    if (!entry.Name) return null
    const folder = entry.Type === 1
    return {
      name: entry.Name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(entry.Size) || 0,
      modifiedAt: 0,
      ref: entry.Hash ?? '',
      mime: folder ? 'application/octet-stream' : driverEntryMime(entry.Name),
    }
  }

  private entryFromLink(link: IpfsLink): DriverEntry | null {
    if (!link.Name) return null
    const folder = link.Type === 1
    return {
      name: link.Name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(link.Size) || 0,
      modifiedAt: 0,
      ref: link.Hash ?? '',
      mime: folder ? 'application/octet-stream' : driverEntryMime(link.Name),
    }
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    await this.authenticate(false)
    if (this.mode === 'mfs') {
      const data = await this.filesLs(this.mountPath(clean))
      const entries = (data.Entries ?? [])
        .map((entry) => this.entryFromFile(entry))
        .filter((entry): entry is DriverEntry => entry !== null)
      return { entries, cursor: null, truncated: false }
    }
    const data = await this.ls(this.contentPath(clean))
    const links = data.Objects?.[0]?.Links ?? []
    const entries = links
      .map((link) => this.entryFromLink(link))
      .filter((entry): entry is DriverEntry => entry !== null)
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    await this.authenticate(false)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }
    const name = driverFileName(clean)
    const parent = driverParentPath(clean)
    if (this.mode === 'mfs') {
      const data = await this.filesLs(this.mountPath(parent))
      const hit = (data.Entries ?? []).find((entry) => entry.Name === name)
      if (!hit) throw DriverError.notFound(`IPFS path not found: ${clean}`)
      const entry = this.entryFromFile(hit)
      if (!entry) throw DriverError.notFound(`IPFS path not found: ${clean}`)
      return entry
    }
    const data = await this.ls(this.contentPath(parent))
    const hit = (data.Objects?.[0]?.Links ?? []).find((link) => link.Name === name)
    if (!hit) throw DriverError.notFound(`IPFS path not found: ${clean}`)
    const entry = this.entryFromLink(hit)
    if (!entry) throw DriverError.notFound(`IPFS path not found: ${clean}`)
    return entry
  }

  private gatewayUrl(cid: string, name: string): string {
    return `${this.gateway}/ipfs/${cid}?filename=${encodeURIComponent(name)}`
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('An IPFS folder cannot be read as a file')
    if (!entry.ref) throw DriverError.upstream('IPFS did not resolve a CID for this file')
    return await this.request(this.gatewayUrl(entry.ref, entry.name), {
      headers: range ? { Range: range } : undefined,
      redirect: 'follow',
    })
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder' || !entry.ref) return null
    return this.gatewayUrl(entry.ref, entry.name)
  }

  private async add(body: Uint8Array, name: string, contentType?: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([body], contentType ? { type: contentType } : undefined), name)
    const response = await this.request(`${this.endpoint}${API_PREFIX}/add`, { method: 'POST', body: form })
    const data = await response.json() as IpfsAddResponse
    if (!data.Hash) throw DriverError.upstream('IPFS add returned no CID')
    return data.Hash
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('A file path is required')
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    const bytes = await asBytes(body)
    const name = driverFileName(clean)
    const hash = await this.add(bytes, name, options.contentType)
    await this.call('files/cp', [`/ipfs/${hash}`, this.mountPath(clean)])
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    await this.call('files/mkdir', [this.mountPath(clean)], { parents: 'true' })
  }

  private validName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
      throw DriverError.invalid(`Invalid file name: ${name}`)
    }
    driverPath(`/${trimmed}`)
    return trimmed
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = this.validName(newName)
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    const target = this.mountPath(driverChildPath(driverParentPath(clean), name))
    await this.call('files/mv', [this.mountPath(clean), target])
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    await this.call('files/mv', [this.mountPath(from), this.mountPath(to)])
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    const entry = await this.stat(from)
    if (!entry.ref) throw DriverError.upstream('IPFS did not resolve a CID for this path')
    await this.call('files/cp', [`/ipfs/${entry.ref}`, this.mountPath(to)])
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be removed')
    await this.authenticate(false)
    if (this.mode !== 'mfs') throw DriverError.unsupported('IPFS only writes through the mfs mode')
    await this.call('files/rm', [this.mountPath(clean)], { recursive: 'true' })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const listed = await this.list('/')
      return { ok: true, message: `IPFS ${this.mode} mount is reachable (${listed.entries.length} entries)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'IPFS is unavailable' }
    }
  }
}

export function createIpfsApiDriver(ctx: DriverContext): MountDriver {
  return new IpfsApiDriver(ctx)
}
