/**
 * GitHub Releases driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/github_releases`: `repoStructure` declares one or
 * more `[path:]org/repo` mounts, the mount root shows the latest release assets (or one folder per
 * tag when `showAllVersion` is on) plus README/LICENSE and optional source bundles. Release lists are
 * walked page by page with `per_page`/`page`, stopping at `maxPage` when it is non-zero.
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

const API_BASE = 'https://api.github.com'
const WEB_PREFIX = 'https://github.com'

interface GhAsset {
  name?: string
  size?: number
  created_at?: string
  updated_at?: string
  browser_download_url?: string
}

interface GhRelease {
  tag_name?: string
  created_at?: string
  published_at?: string
  zipball_url?: string
  tarball_url?: string
  assets?: GhAsset[]
}

interface GhContent {
  name?: string
  size?: number
  download_url?: string | null
}

interface GhMount {
  point: string
  repo: string
}

interface ResolvedFile {
  name: string
  size: number
  modifiedAt: number
  url: string
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

class GithubReleasesDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('github_releases')!
  readonly capabilities = this.definition.capabilities
  private mounts: GhMount[] = []
  private token = ''
  private rootPath = '/'
  private showReadme = true
  private showSourceCode = false
  private showAllVersion = false
  private perPage = 30
  private maxPage = 0
  private ghProxy = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    this.rootPath = driverPath(this.configText('rootPath') || '/')
    const structure = this.configText('repoStructure').trim()
    if (!structure) {
      throw DriverError.invalid('GitHub Releases needs a repoStructure (format: [path:]org/repo)')
    }
    this.mounts = this.parseMounts(structure)
    if (this.mounts.length === 0) {
      throw DriverError.invalid('GitHub Releases needs at least one repository in repoStructure')
    }
    this.token = (this.ctx.credentials.token ?? '').trim()
    this.showReadme = this.configFlag('showReadme', true)
    this.showSourceCode = this.configFlag('showSourceCode', false)
    this.showAllVersion = this.configFlag('showAllVersion', false)
    this.perPage = clampNumber(this.configNumber('perPage', 30), 30, 1, 100)
    this.maxPage = Math.max(0, Math.floor(this.configNumber('maxPage', 0)))
    this.ghProxy = this.configText('ghProxy').trim().replace(/\/+$/, '')
  }

  private configFlag(key: string, fallback: boolean): boolean {
    const value = this.ctx.config[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
    }
    return fallback
  }

  private configNumber(key: string, fallback: number): number {
    const value = this.ctx.config[key]
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    return fallback
  }

  private parseMounts(structure: string): GhMount[] {
    const mounts: GhMount[] = []
    for (const raw of structure.split(/[\r\n;]+/)) {
      const item = raw.trim()
      if (!item) continue
      const colon = item.indexOf(':')
      let point = '/'
      let repo = item
      if (colon >= 0) {
        if (item.indexOf(':', colon + 1) >= 0) throw DriverError.invalid(`Invalid repoStructure entry: ${item}`)
        point = driverPath(item.slice(0, colon).trim() || '/')
        repo = item.slice(colon + 1).trim()
      }
      if (!repo) throw DriverError.invalid(`Invalid repoStructure entry: ${item}`)
      mounts.push({ point: this.applyRoot(point), repo })
    }
    return mounts
  }

  private applyRoot(point: string): string {
    if (this.rootPath === '/') return point
    return point === '/' ? this.rootPath : `${this.rootPath}${point}`
  }

  private fullPath(path: string): string {
    if (this.rootPath === '/') return path
    return path === '/' ? this.rootPath : `${this.rootPath}${path}`
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'inkstone-clouddrive',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    }
  }

  private async get<T>(url: string): Promise<T> {
    return await this.json<T>(url, { headers: this.headers() })
  }

  private async getOptional<T>(url: string): Promise<T | null> {
    try {
      return await this.get<T>(url)
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw error
    }
  }

  private proxyUrl(url: string | undefined): string {
    if (!url) return ''
    const prefix = this.ghProxy
    if (!prefix || !url.startsWith(WEB_PREFIX)) return url
    return prefix + url.slice(WEB_PREFIX.length)
  }

  private latestRelease(repo: string): Promise<GhRelease | null> {
    return this.getOptional<GhRelease>(`${API_BASE}/repos/${repo}/releases/latest`)
  }

  private async allReleases(repo: string): Promise<{ releases: GhRelease[]; truncated: boolean }> {
    const releases: GhRelease[] = []
    for (let page = 1; this.maxPage === 0 || page <= this.maxPage; page++) {
      const data = await this.get<GhRelease[]>(
        `${API_BASE}/repos/${repo}/releases?per_page=${this.perPage}&page=${page}`,
      )
      if (!Array.isArray(data)) throw DriverError.upstream('GitHub Releases returned an unexpected release list')
      if (data.length === 0) return { releases, truncated: false }
      releases.push(...data)
      if (data.length < this.perPage) return { releases, truncated: false }
    }
    return { releases, truncated: this.maxPage > 0 }
  }

  private async repoContents(repo: string): Promise<GhContent[] | null> {
    const contents = await this.getOptional<GhContent[]>(`${API_BASE}/repos/${repo}/contents`)
    if (contents === null) return null
    if (!Array.isArray(contents)) throw DriverError.upstream('GitHub Releases returned an unexpected repository listing')
    return contents
  }

  private releaseSize(release: GhRelease): number {
    return (release.assets ?? []).reduce((sum, asset) => sum + (Number(asset.size) || 0), 0)
  }

  private assetEntries(release: GhRelease): DriverEntry[] {
    return (release.assets ?? []).map((asset) => {
      const name = asset.name ?? ''
      return {
        name,
        kind: 'file' as const,
        size: Number(asset.size) || 0,
        modifiedAt: timestamp(asset.updated_at ?? asset.created_at),
        ref: this.proxyUrl(asset.browser_download_url),
        mime: driverEntryMime(name),
      }
    })
  }

  private sourceEntries(release: GhRelease): DriverEntry[] {
    if (!this.showSourceCode) return []
    return [
      {
        name: 'Source code (zip)',
        kind: 'file',
        size: 1,
        modifiedAt: timestamp(release.created_at),
        ref: this.proxyUrl(release.zipball_url),
        mime: driverEntryMime('Source code (zip)'),
      },
      {
        name: 'Source code (tar.gz)',
        kind: 'file',
        size: 1,
        modifiedAt: timestamp(release.created_at),
        ref: this.proxyUrl(release.tarball_url),
        mime: driverEntryMime('Source code (tar.gz)'),
      },
    ]
  }

  private readmeEntries(contents: GhContent[]): DriverEntry[] {
    return contents
      .filter((entry) => {
        const name = entry.name ?? ''
        return name.toLowerCase().endsWith('.md') || name.toUpperCase().startsWith('LICENSE')
      })
      .map((entry) => ({
        name: entry.name ?? '',
        kind: 'file' as const,
        size: Number(entry.size) || 0,
        modifiedAt: 0,
        ref: this.proxyUrl(entry.download_url ?? undefined),
        mime: driverEntryMime(entry.name ?? ''),
      }))
  }

  private async mountContent(repo: string): Promise<{ entries: DriverEntry[]; truncated: boolean }> {
    const entries: DriverEntry[] = []
    let truncated = false
    if (this.showAllVersion) {
      const all = await this.allReleases(repo)
      entries.push(...all.releases.map((release) => ({
        name: release.tag_name ?? '',
        kind: 'folder' as const,
        size: this.releaseSize(release),
        modifiedAt: timestamp(release.published_at ?? release.created_at),
        ref: release.tag_name ?? '',
        mime: 'application/octet-stream',
      })))
      truncated = all.truncated
    } else {
      const release = await this.latestRelease(repo)
      if (release) {
        entries.push(...this.assetEntries(release))
        entries.push(...this.sourceEntries(release))
      }
    }
    if (this.showReadme) {
      const contents = await this.repoContents(repo)
      if (contents) entries.push(...this.readmeEntries(contents))
    }
    return { entries, truncated }
  }

  private mountForPath(path: string): GhMount | null {
    let best: GhMount | null = null
    let bestLength = -1
    for (const mount of this.mounts) {
      const point = mount.point === '/' ? '' : mount.point
      if (point !== '' && path !== point && !path.startsWith(`${point}/`)) continue
      if (point.length > bestLength) {
        best = mount
        bestLength = point.length
      }
    }
    return best
  }

  private relPath(mount: GhMount, path: string): string {
    const point = mount.point === '/' ? '' : mount.point
    return path.slice(point.length).replace(/^\/+/, '')
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const full = this.fullPath(clean)
      const entries: DriverEntry[] = []
      let truncated = false
      for (const mount of this.mounts) {
        if (mount.point === full) {
          const content = await this.mountContent(mount.repo)
          entries.push(...content.entries)
          truncated ||= content.truncated
          continue
        }
        const prefix = full === '/' ? '/' : `${full}/`
        if (mount.point !== '/' && mount.point.startsWith(prefix)) {
          const name = mount.point.slice(prefix.length).split('/')[0] ?? ''
          if (name && !entries.some((entry) => entry.name === name)) {
            entries.push({
              name,
              kind: 'folder',
              size: 0,
              modifiedAt: 0,
              ref: '',
              mime: 'application/octet-stream',
            })
          }
          continue
        }
        if (!this.showAllVersion) continue
        if (mount.point !== '/' && !full.startsWith(`${mount.point}/`)) continue
        const rel = mount.point === '/' ? full.slice(1) : full.slice(mount.point.length + 1)
        if (!rel || rel.includes('/')) continue
        const all = await this.allReleases(mount.repo)
        const release = all.releases.find((candidate) => candidate.tag_name === rel)
        if (release) {
          entries.push(...this.assetEntries(release))
          entries.push(...this.sourceEntries(release))
        }
        truncated ||= all.truncated
      }
      if (options.page !== undefined) {
        const pageSize = Math.min(1_000, Math.max(1, options.pageSize ?? this.perPage))
        const page = Math.max(1, Math.floor(options.page))
        const start = (page - 1) * pageSize
        const pageEntries = entries.slice(start, start + pageSize)
        const hasMore = start + pageSize < entries.length
        return {
          entries: pageEntries,
          cursor: hasMore ? String(page + 1) : null,
          truncated: truncated || hasMore,
        }
      }
      return { entries, cursor: null, truncated }
    })
  }

  private async isDirectory(path: string): Promise<boolean> {
    if (path === '/') return true
    for (const mount of this.mounts) {
      if (path === mount.point) return true
      if (mount.point !== '/' && mount.point.startsWith(`${path}/`)) return true
    }
    if (!this.showAllVersion) return false
    const mount = this.mountForPath(path)
    if (!mount) return false
    const rel = this.relPath(mount, path)
    if (!rel || rel.includes('/')) return false
    const all = await this.allReleases(mount.repo)
    return all.releases.some((release) => release.tag_name === rel)
  }

  private sourceUrl(name: string, release: GhRelease): string {
    if (name === 'Source code (zip)') return release.zipball_url ?? ''
    if (name === 'Source code (tar.gz)') return release.tarball_url ?? ''
    return ''
  }

  private assetFile(asset: GhAsset): ResolvedFile | null {
    const name = asset.name ?? ''
    const url = this.proxyUrl(asset.browser_download_url)
    if (!name || !url) return null
    return {
      name,
      size: Number(asset.size) || 0,
      modifiedAt: timestamp(asset.updated_at ?? asset.created_at),
      url,
    }
  }

  private async resolveFile(path: string): Promise<ResolvedFile | null> {
    const mount = this.mountForPath(path)
    if (!mount) return null
    const rel = this.relPath(mount, path)
    const segments = rel.split('/').filter(Boolean)
    const name = segments[segments.length - 1]
    if (!name) return null

    if (segments.length >= 2) {
      const all = await this.allReleases(mount.repo)
      const tagged = all.releases.find((release) => release.tag_name === segments[0])
      if (tagged) {
        const asset = (tagged.assets ?? []).find((candidate) => candidate.name === name)
        if (asset) return this.assetFile(asset)
        const source = this.sourceUrl(name, tagged)
        if (source) return { name, size: 1, modifiedAt: timestamp(tagged.created_at), url: this.proxyUrl(source) }
      }
    }

    const latest = await this.latestRelease(mount.repo)
    if (latest) {
      const asset = (latest.assets ?? []).find((candidate) => candidate.name === name)
      if (asset) return this.assetFile(asset)
      const source = this.sourceUrl(name, latest)
      if (source) return { name, size: 1, modifiedAt: timestamp(latest.created_at), url: this.proxyUrl(source) }
    }

    const all = await this.allReleases(mount.repo)
    for (const release of all.releases) {
      const asset = (release.assets ?? []).find((candidate) => candidate.name === name)
      if (asset) return this.assetFile(asset)
    }

    const contents = await this.repoContents(mount.repo)
    const match = (contents ?? []).find((entry) => entry.name === name)
    if (match?.download_url) {
      return {
        name: match.name ?? name,
        size: Number(match.size) || 0,
        modifiedAt: 0,
        url: this.proxyUrl(match.download_url),
      }
    }
    return null
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const full = this.fullPath(clean)
      if (await this.isDirectory(full)) {
        const name = full === '/' ? 'root' : full.slice(full.lastIndexOf('/') + 1)
        return { name, kind: 'folder', size: 0, modifiedAt: 0, mime: 'application/octet-stream' }
      }
      const file = await this.resolveFile(full)
      if (!file) throw DriverError.notFound(`GitHub release path not found: ${clean}`)
      return {
        name: file.name,
        kind: 'file',
        size: file.size,
        modifiedAt: file.modifiedAt,
        ref: file.url,
        mime: driverEntryMime(file.name),
      }
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const full = this.fullPath(clean)
      if (await this.isDirectory(full)) throw DriverError.unsupported('A GitHub release folder cannot be read as a file')
      const file = await this.resolveFile(full)
      if (!file) throw DriverError.notFound(`GitHub release path not found: ${clean}`)
      return await this.request(file.url, {
        headers: range ? { Range: range } : undefined,
        redirect: 'follow',
      })
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub Releases is read-only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub Releases is read-only')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub Releases is read-only')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('GitHub Releases is read-only')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub Releases is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const listed = await this.list('/')
      return { ok: true, message: `GitHub Releases is reachable (${listed.entries.length} entries)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'GitHub Releases is unavailable' }
    }
  }
}

export function createGithubReleasesDriver(ctx: DriverContext): MountDriver {
  return new GithubReleasesDriver(ctx)
}
