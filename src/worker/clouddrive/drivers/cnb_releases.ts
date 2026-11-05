/**
 * CNB (cnb.cool) Releases driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/cnb_releases`: a release is a virtual folder at
 * the mount root and its assets are the files inside it. The API is addressed by release/asset id,
 * so names from the mount path are resolved against the release list before any write. Downloads
 * use the public web URL of the asset (`https://cnb.cool<asset.path>`).
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
import { HttpDriverBase, driverPath } from './http'

const API_BASE = 'https://api.cnb.cool'
const WEB_BASE = 'https://cnb.cool'

interface CnbAsset {
  id?: string
  name?: string
  size?: number
  path?: string
  created_at?: string
  updated_at?: string
}

interface CnbRelease {
  id?: string
  name?: string
  tag_name?: string
  created_at?: string
  updated_at?: string
  assets?: CnbAsset[]
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0
}

class CnbReleasesDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('cnb_releases')!
  readonly capabilities = this.definition.capabilities
  private repo = ''
  private token = ''
  private useTagName = false
  private defaultBranch = 'main'

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    const repo = this.configText('repo').trim().replace(/^\/+|\/+$/g, '')
    if (!repo) throw DriverError.invalid('CNB Releases needs a repository (org/repo)')
    const token = (this.ctx.credentials.token ?? '').trim()
    if (!token) throw DriverError.auth('CNB Releases needs an access token')
    this.repo = repo
    this.token = token
    this.useTagName = this.configFlag('useTagName')
    const branch = this.configText('defaultBranch').trim()
    this.defaultBranch = branch || 'main'
  }

  private configFlag(key: string): boolean {
    const value = this.ctx.config[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value === 'true' || value === '1'
    return false
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      ...extra,
    }
  }

  private async listReleases(): Promise<CnbRelease[]> {
    const data = await this.json<CnbRelease[]>(`${API_BASE}/${this.repo}/-/releases`, {
      headers: this.headers(),
    })
    if (!Array.isArray(data)) throw DriverError.upstream('CNB Releases returned an unexpected release list')
    return data
  }

  private async findRelease(idOrName: string): Promise<CnbRelease | null> {
    const releases = await this.listReleases()
    return releases.find((release) => release.id === idOrName)
      ?? releases.find((release) => this.releaseName(release) === idOrName)
      ?? releases.find((release) => release.tag_name === idOrName)
      ?? null
  }

  private releaseName(release: CnbRelease): string {
    if (this.useTagName) return release.tag_name ?? ''
    return release.name || release.tag_name || ''
  }

  private releaseSize(release: CnbRelease): number {
    return (release.assets ?? []).reduce((sum, asset) => sum + (Number(asset.size) || 0), 0)
  }

  private releaseEntry(release: CnbRelease): DriverEntry {
    return {
      name: this.releaseName(release),
      kind: 'folder',
      size: this.releaseSize(release),
      modifiedAt: timestamp(release.updated_at ?? release.created_at),
      ref: release.id ?? '',
      mime: 'application/octet-stream',
    }
  }

  private assetEntry(asset: CnbAsset): DriverEntry {
    const name = asset.name ?? ''
    return {
      name,
      kind: 'file',
      size: Number(asset.size) || 0,
      modifiedAt: timestamp(asset.updated_at ?? asset.created_at),
      ref: asset.id ?? '',
      mime: driverEntryMime(name),
    }
  }

  private segments(path: string): string[] {
    return path === '/' ? [] : path.slice(1).split('/').filter(Boolean)
  }

  private findAsset(release: CnbRelease, idOrName: string): CnbAsset | null {
    const assets = release.assets ?? []
    return assets.find((asset) => asset.id === idOrName)
      ?? assets.find((asset) => asset.name === idOrName)
      ?? null
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length === 0) {
        const releases = await this.listReleases()
        return { entries: releases.map((release) => this.releaseEntry(release)), cursor: null, truncated: false }
      }
      if (parts.length > 1) throw DriverError.notFound(`${clean} is not a release folder`)
      const release = await this.findRelease(parts[0]!)
      if (!release) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
      return { entries: (release.assets ?? []).map((asset) => this.assetEntry(asset)), cursor: null, truncated: false }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length === 0) {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }
      }
      if (parts.length === 1) {
        const release = await this.findRelease(parts[0]!)
        if (!release) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
        return this.releaseEntry(release)
      }
      if (parts.length === 2) {
        const release = await this.findRelease(parts[0]!)
        if (!release) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
        const asset = this.findAsset(release, parts[1]!)
        if (!asset) throw DriverError.notFound(`CNB asset not found: ${parts[1]}`)
        return this.assetEntry(asset)
      }
      throw DriverError.notFound(`CNB path not found: ${clean}`)
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length !== 2) throw DriverError.unsupported('Only a CNB release asset can be read')
      const release = await this.findRelease(parts[0]!)
      if (!release) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
      const asset = this.findAsset(release, parts[1]!)
      if (!asset?.path) throw DriverError.notFound(`CNB asset not found: ${parts[1]}`)
      return await this.request(`${WEB_BASE}${asset.path}`, {
        headers: range ? { Range: range } : undefined,
        redirect: 'follow',
      })
    })
  }

  private validName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
      throw DriverError.invalid(`Invalid release name: ${name}`)
    }
    driverPath(`/${trimmed}`)
    return trimmed
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('CNB Releases cannot accept asset uploads')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length !== 1) throw DriverError.unsupported('CNB Releases can only create releases at the mount root')
      const name = this.validName(parts[0]!)
      const response = await this.request(`${API_BASE}/${this.repo}/-/releases`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, tag_name: name, target_commitish: this.defaultBranch }),
      })
      await response.body?.cancel().catch(() => undefined)
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = this.validName(newName)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length !== 1) throw DriverError.unsupported('Only a CNB release can be renamed')
      if (this.useTagName) throw DriverError.unsupported('CNB releases are addressed by tag name here; rename is disabled')
      const release = await this.findRelease(parts[0]!)
      if (!release?.id) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
      const response = await this.request(`${API_BASE}/${this.repo}/-/releases/${release.id}`, {
        method: 'PATCH',
        headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams({ name }),
      })
      await response.body?.cancel().catch(() => undefined)
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('CNB Releases cannot move releases or assets')
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const parts = this.segments(clean)
      if (parts.length === 1) {
        const release = await this.findRelease(parts[0]!)
        if (!release?.id) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
        const response = await this.request(`${API_BASE}/${this.repo}/-/releases/${release.id}`, {
          method: 'DELETE',
          headers: this.headers(),
        })
        await response.body?.cancel().catch(() => undefined)
        return
      }
      if (parts.length === 2) {
        const release = await this.findRelease(parts[0]!)
        if (!release?.id) throw DriverError.notFound(`CNB release not found: ${parts[0]}`)
        const asset = this.findAsset(release, parts[1]!)
        if (!asset?.id) throw DriverError.notFound(`CNB asset not found: ${parts[1]}`)
        const response = await this.request(`${API_BASE}/${this.repo}/-/releases/${release.id}/assets/${asset.id}`, {
          method: 'DELETE',
          headers: this.headers(),
        })
        await response.body?.cancel().catch(() => undefined)
        return
      }
      throw DriverError.notFound(`CNB path not found: ${clean}`)
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const releases = await this.withAuth(async () => await this.listReleases())
      return { ok: true, message: `CNB Releases is reachable (${releases.length} releases)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'CNB Releases is unavailable' }
    }
  }
}

export function createCnbReleasesDriver(ctx: DriverContext): MountDriver {
  return new CnbReleasesDriver(ctx)
}
