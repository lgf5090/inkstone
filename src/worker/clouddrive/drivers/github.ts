/**
 * GitHub repository driver.
 *
 * A repository is a flat object store with commits: the Contents API lists one directory at a time,
 * reads a file with `Accept: application/vnd.github.raw`, and writes a file with one PUT carrying the
 * base64 body and, when overwriting, the previous blob sha. Directories are only implicitly created
 * by writing a file inside them, so `mkdir`/rename/move/copy are not part of the capability set.
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
import { HttpDriverBase, driverFileName, driverPath } from './http'

const API = 'https://api.github.com'
const JSON_ACCEPT = 'application/vnd.github+json'
const RAW_ACCEPT = 'application/vnd.github.raw'
const PAGE_SIZE = 100

interface GitHubContent {
  name: string
  path: string
  sha: string
  size?: number
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url?: string | null
}

function contentEntry(item: GitHubContent): DriverEntry {
  const folder = item.type === 'dir'
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: Number(item.size) || 0,
    modifiedAt: 0,
    ref: item.sha,
    mime: folder ? 'application/octet-stream' : driverEntryMime(item.name),
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function normalizeRoot(input: string): string {
  return input.replace(/^\/+|\/+$/g, '')
}

export class GitHubDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('github')!
  readonly capabilities = this.definition.capabilities
  private readonly repo: string
  private readonly branch: string
  private readonly rootPath: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.repo = String(ctx.config.repo ?? '').trim()
    if (!this.repo.includes('/')) throw DriverError.auth('GitHub needs a repository configured as owner/name')
    this.branch = String(ctx.config.branch ?? '').trim() || 'main'
    this.rootPath = normalizeRoot(String(ctx.config.rootPath ?? ''))
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'inkstone-clouddrive',
    }
    const token = String(this.ctx.credentials.token ?? '')
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /**
   * GitHub has no login endpoint: the PAT is proved by the first Contents call. Validation here is
   * deliberately offline so a listing does not cost an extra `/repos` request.
   */
  protected async login(_force: boolean): Promise<void> {
    if (!this.repo) throw DriverError.auth('GitHub needs a repository configured as owner/name')
  }

  private repoPath(clean: string): string {
    const relative = clean === '/' ? '' : clean.slice(1)
    return this.rootPath ? (relative ? `${this.rootPath}/${relative}` : this.rootPath) : relative
  }

  private contentsUrl(clean: string): string {
    const path = this.repoPath(clean)
    const suffix = path
      ? `/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
      : ''
    return `${API}/repos/${this.repo}/contents${suffix}?ref=${encodeURIComponent(this.branch)}`
  }

  private async readContents(url: string): Promise<GitHubContent[]> {
    const response = await this.request(url, { headers: this.headers(JSON_ACCEPT) })
    const payload = await response.json() as GitHubContent | GitHubContent[]
    if (!Array.isArray(payload)) throw DriverError.notFound('The path is not a folder')
    return payload.filter((item) => item.name !== '.gitkeep')
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      let entries = (await this.readContents(this.contentsUrl(clean))).map(contentEntry)
      if (options.search) {
        const needle = options.search.toLowerCase()
        entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
        const offset = (Math.max(1, options.page) - 1) * pageSize
        const pageEntries = entries.slice(offset, offset + pageSize)
        const nextOffset = offset + pageEntries.length < entries.length ? String(offset + pageEntries.length) : null
        return { entries: pageEntries, cursor: nextOffset, truncated: nextOffset !== null }
      }
      return { entries, cursor: null, truncated: false }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const response = await this.request(this.contentsUrl(clean), { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) {
        return {
          name: clean === '/' ? 'root' : driverFileName(clean),
          kind: 'folder',
          size: 0,
          modifiedAt: 0,
        }
      }
      return contentEntry(payload)
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      return await this.request(this.contentsUrl(clean), {
        headers: { ...this.headers(RAW_ACCEPT), ...(range ? { Range: range } : {}) },
        redirect: 'follow',
        timeoutMs: 30_000,
      })
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const response = await this.request(this.contentsUrl(clean), { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) return null
      return payload.download_url ? payload.download_url : null
    })
  }

  /** Reads the current blob sha so an overwrite PUT can use GitHub's compare-and-swap. */
  private async existingSha(url: string): Promise<string | null> {
    try {
      const response = await this.request(url, { headers: this.headers(JSON_ACCEPT) })
      const payload = await response.json() as GitHubContent | GitHubContent[]
      if (Array.isArray(payload)) throw DriverError.unsupported('A folder cannot be written as a file')
      return payload.sha || null
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw error
    }
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const content = base64Of(bytes)
    await this.withAuth(async () => {
      const url = this.contentsUrl(clean)
      const put = async (sha: string | null): Promise<void> => {
        const payload: Record<string, unknown> = {
          message: `Upload ${driverFileName(clean)}`,
          content,
          branch: this.branch,
        }
        if (sha) payload.sha = sha
        const response = await this.request(url, {
          method: 'PUT',
          headers: { ...this.headers(JSON_ACCEPT), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        await response.body?.cancel().catch(() => undefined)
      }
      try {
        await put(await this.existingSha(url))
      } catch (error) {
        // A stale sha is answered with 409 Conflict (or 422 on some GitHub-compatible hosts). Re-read
        // the current sha and retry once, which is the only way the Contents API allows an overwrite.
        if (!(error instanceof DriverError) || error.kind !== 'upstream' || !/HTTP (409|422)/.test(error.message)) throw error
        await put(await this.existingSha(url))
      }
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.withAuth(async () => {
      const url = this.contentsUrl(clean)
      const sha = await this.existingSha(url)
      if (!sha) throw DriverError.notFound(`GitHub could not resolve ${clean}`)
      const response = await this.request(url, {
        method: 'DELETE',
        headers: { ...this.headers(JSON_ACCEPT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Delete ${driverFileName(clean)}`, sha, branch: this.branch }),
      })
      await response.body?.cancel().catch(() => undefined)
    })
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub creates folders by writing a file inside them')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('GitHub cannot rename in place')
  }

  async move(fromPath: string, _toPath: string): Promise<void> {
    driverPath(fromPath)
    throw DriverError.unsupported('GitHub cannot move files')
  }

  async copy(fromPath: string, _toPath: string): Promise<void> {
    driverPath(fromPath)
    throw DriverError.unsupported('GitHub cannot copy files')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.request(`${API}/repos/${this.repo}`, { headers: this.headers(JSON_ACCEPT) })
      await response.body?.cancel().catch(() => undefined)
      return { ok: true, message: `GitHub is reachable · ${this.repo}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'GitHub is unavailable' }
    }
  }
}

export function createGitHubDriver(ctx: DriverContext): MountDriver {
  return new GitHubDriver(ctx)
}
