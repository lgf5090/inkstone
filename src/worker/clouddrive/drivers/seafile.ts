/**
 * Seafile storage driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/seafile`:
 * `POST /api2/auth-token/` for credentials, `/api2/repos/<id>/dir/` to list, `/file/` to download,
 * upload and mutate, and `/upload-link/` to obtain the upload endpoint. A configured `repoId` pins
 * one library; without it the root lists the account's libraries and the first path segment picks
 * one, exactly as the reference does.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
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

const TIMEOUT_MS = 30_000
const DECRYPT_CACHE_MS = 30 * 60 * 1000

interface SeafileItem {
  id: string
  type: 'repo' | 'dir' | 'file'
  name: string
  size?: number
  mtime?: number
  encrypted?: boolean
}

interface SeafileRepo extends SeafileItem {
  owner?: string
}

interface ResolvedPath {
  repoId: string
  innerPath: string
  /** The mount root without a pinned repo lists libraries instead of a directory. */
  listings: boolean
}

async function downloadFailure(response: Response, service: string): Promise<DriverError> {
  const body = await response.text().catch(() => '')
  let message = ''
  try {
    const parsed = JSON.parse(body) as { message?: unknown; msg?: unknown; error?: unknown }
    const candidate = parsed.message ?? parsed.msg ?? parsed.error
    if (typeof candidate === 'string') message = candidate
  } catch {
    message = body.slice(0, 200)
  }
  const suffix = message ? `: ${message}` : ''
  if (response.status === 401 || response.status === 403) {
    return DriverError.auth(`The storage refused the credentials (HTTP ${response.status}${suffix})`)
  }
  if (response.status === 404) return DriverError.notFound(`Not found upstream (HTTP 404${suffix})`)
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited(
      `The upstream service is rate limiting requests${suffix}`,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    )
  }
  return DriverError.upstream(`${service} answered HTTP ${response.status}${suffix}`)
}

function entryOf(item: SeafileItem): DriverEntry {
  const folder = item.type === 'dir' || item.type === 'repo'
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(item.size) || 0,
    modifiedAt: item.mtime ? item.mtime * 1000 : 0,
    ref: item.id,
    ...(folder ? {} : { mime: driverEntryMime(item.name) }),
  }
}

class SeafileDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('seafile')!
  readonly capabilities = this.definition.capabilities
  private readonly address: string
  private readonly root: string
  private readonly configuredRepo: string
  private token = ''
  private readonly decrypted = new Map<string, number>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.address = this.configText('address').trim().replace(/\/+$/, '')
    try {
      this.root = driverPath(this.configText('rootPath', '/').trim() || '/')
    } catch {
      throw DriverError.invalid('The Seafile root path is invalid')
    }
    this.configuredRepo = this.configText('repoId').trim()
  }

  private credential(key: string): string {
    return this.ctx.credentials[key] || this.configText(key)
  }

  protected async login(force: boolean): Promise<void> {
    const storedToken = this.credential('token').trim()
    const username = this.credential('username').trim()
    const password = this.credential('password')
    const canSignIn = Boolean(username && password) && (force || !storedToken)
    if (storedToken && !canSignIn) {
      this.token = storedToken
      return
    }
    if (!username || !password) {
      throw DriverError.auth('Seafile needs a token or a username and password')
    }
    const response = await this.request(`${this.address}/api2/auth-token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ username, password }).toString(),
    })
    const payload = await response.json().catch(() => null) as { token?: string } | null
    if (!payload?.token) throw DriverError.auth('Seafile did not return an authentication token')
    this.token = payload.token
    await this.saveCredential({ token: payload.token })
  }

  private prefix(clean: string): string {
    if (this.root === '/') return clean
    return clean === '/' ? this.root : `${this.root}${clean}`
  }

  private repoPath(repoId: string): string {
    return `/api2/repos/${encodeURIComponent(repoId)}`
  }

  private withQuery(path: string, params: Record<string, string>): string {
    return `${path}?${new URLSearchParams(params).toString()}`
  }

  private async api<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; form?: Record<string, string> } = {},
  ): Promise<T> {
    return await this.withAuth(async () => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (this.token) headers.Authorization = `Token ${this.token}`
      if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const response = await this.request(`${this.address}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.form ? new URLSearchParams(options.form).toString() : undefined,
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('json')) return await response.json() as T
      const text = await response.text()
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    })
  }

  private async repos(): Promise<SeafileRepo[]> {
    return await this.api<SeafileRepo[]>('/api2/repos/')
  }

  private async decrypt(repo: SeafileRepo): Promise<void> {
    if (!repo.encrypted) return
    const last = this.decrypted.get(repo.id) ?? 0
    if (Date.now() - last < DECRYPT_CACHE_MS) return
    const password = this.credential('repoPwd')
    if (!password) throw DriverError.auth(`Seafile library ${repo.name} is encrypted and needs a library password`)
    const result = await this.api<string>(`${this.repoPath(repo.id)}/`, {
      method: 'POST',
      form: { password },
    })
    if (typeof result === 'string' && result.includes('success')) {
      this.decrypted.set(repo.id, Date.now())
      return
    }
    throw DriverError.auth(`Seafile could not decrypt library ${repo.name}`)
  }

  private async resolve(path: string): Promise<ResolvedPath> {
    const clean = driverPath(path)
    if (this.configuredRepo) {
      return { repoId: this.configuredRepo, innerPath: this.prefix(clean), listings: false }
    }
    if (clean === '/') return { repoId: '', innerPath: '/', listings: true }

    const segments = clean.split('/').filter(Boolean)
    const repoName = segments[0]!
    const rest = segments.length > 1 ? `/${segments.slice(1).join('/')}` : '/'
    const libraries = await this.repos()
    const match = libraries.find((repo) => repo.name === repoName || repo.id === repoName)
    if (!match) throw DriverError.notFound(`Seafile library not found: ${repoName}`)
    await this.decrypt(match)
    return { repoId: match.id, innerPath: this.prefix(rest), listings: false }
  }

  private async listDir(repoId: string, innerPath: string): Promise<SeafileItem[]> {
    const url = this.withQuery(`${this.repoPath(repoId)}/dir/`, { p: innerPath })
    return await this.api<SeafileItem[]>(url)
  }

  async list(path: string): Promise<DriverListResult> {
    const resolved = await this.resolve(path)
    if (resolved.listings) {
      const libraries = await this.repos()
      return {
        entries: libraries.map((repo) => entryOf({ ...repo, type: 'repo' })),
        cursor: null,
        truncated: false,
      }
    }
    const items = await this.listDir(resolved.repoId, resolved.innerPath)
    return { entries: items.map(entryOf), cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const resolved = await this.resolve(clean)
    if (resolved.listings) {
      return { name: '/', kind: 'folder', size: 0, modifiedAt: 0 }
    }
    if (resolved.innerPath === '/') {
      const repo = await this.api<SeafileRepo>(`${this.repoPath(resolved.repoId)}/`)
      return entryOf({ ...repo, type: 'repo', name: repo.name || driverFileName(clean) || '/' })
    }
    const parent = driverParentPath(resolved.innerPath)
    const name = driverFileName(resolved.innerPath)
    const siblings = await this.listDir(resolved.repoId, parent)
    const found = siblings.find((item) => item.name === name)
    if (!found) throw DriverError.notFound(`Seafile object not found: ${name}`)
    return entryOf(found)
  }

  private async downloadLink(resolved: ResolvedPath): Promise<string> {
    if (resolved.listings || resolved.innerPath === '/') {
      throw DriverError.unsupported('A Seafile library root cannot be downloaded as a file')
    }
    const url = this.withQuery(`${this.repoPath(resolved.repoId)}/file/`, {
      p: resolved.innerPath,
      reuse: '1',
    })
    const raw = await this.api<string>(url)
    const link = typeof raw === 'string' ? raw.replace(/^"|"$/g, '').trim() : ''
    if (!link) throw DriverError.upstream('Seafile did not return a download address')
    if (link.startsWith('/')) return `${this.address}${link}`
    if (!/^https?:/i.test(link)) return new URL(link, `${this.address}/`).toString()
    return link
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const resolved = await this.resolve(path)
    const link = await this.downloadLink(resolved)
    let response: Response
    try {
      response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: range ? { Range: range } : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw DriverError.upstream(
        `The Seafile download could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 200 || response.status === 206) return response
    throw await downloadFailure(response, 'Seafile download')
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const resolved = await this.resolve(path)
    if (resolved.listings || resolved.innerPath === '/') {
      throw DriverError.invalid('A file path is required')
    }
    const bytes = await asBytes(body)
    const parent = driverParentPath(resolved.innerPath)
    const name = driverFileName(resolved.innerPath)
    await this.withAuth(async () => {
      const link = await this.api<string>(
        this.withQuery(`${this.repoPath(resolved.repoId)}/upload-link/`, { p: parent }),
      )
      const uploadUrl = typeof link === 'string' ? link.replace(/^"|"$/g, '').trim() : ''
      if (!uploadUrl) throw DriverError.upstream('Seafile did not return an upload address')

      const form = new FormData()
      form.append('parent_dir', parent)
      form.append('replace', '1')
      form.append('file', new Blob([bytes], { type: options.contentType || 'application/octet-stream' }), name)
      let response: Response
      try {
        response = await fetch(uploadUrl, {
          method: 'POST',
          headers: this.token ? { Authorization: `Token ${this.token}` } : undefined,
          body: form,
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        throw DriverError.upstream(
          `The Seafile upload could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!response.ok) throw await downloadFailure(response, 'Seafile upload')
    })
    options.onProgress?.(bytes.byteLength, options.size || bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const resolved = await this.resolve(path)
    if (resolved.listings) throw DriverError.invalid('A library name is required')
    if (resolved.innerPath === '/') return
    await this.api(this.withQuery(`${this.repoPath(resolved.repoId)}/dir/`, { p: resolved.innerPath }), {
      method: 'POST',
      form: { operation: 'mkdir' },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be renamed')
    const target = driverPath(driverChildPath(driverParentPath(clean), newName))
    if (target === clean) return
    const resolved = await this.resolve(clean)
    if (resolved.listings || resolved.innerPath === '/') throw DriverError.invalid('A library root cannot be renamed')
    await this.api(this.withQuery(`${this.repoPath(resolved.repoId)}/file/`, { p: resolved.innerPath }), {
      method: 'POST',
      form: { operation: 'rename', newname: newName },
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be deleted')
    const resolved = await this.resolve(clean)
    if (resolved.listings || resolved.innerPath === '/') throw DriverError.unsupported('A Seafile library cannot be deleted here')
    await this.api(this.withQuery(`${this.repoPath(resolved.repoId)}/file/`, { p: resolved.innerPath }), {
      method: 'DELETE',
    })
  }

  private async transfer(path: string, destination: string, operation: 'move' | 'copy'): Promise<void> {
    const clean = driverPath(path)
    const target = driverPath(destination)
    if (clean === '/' || target === '/') throw DriverError.invalid('The mount root cannot be moved')
    const source = await this.resolve(clean)
    const dst = await this.resolve(target)
    if (source.listings || source.innerPath === '/' || dst.listings || dst.innerPath === '/') {
      throw DriverError.unsupported('Seafile libraries cannot be transferred this way')
    }
    const dstDir = driverParentPath(dst.innerPath)
    await this.api(this.withQuery(`${this.repoPath(source.repoId)}/file/`, { p: source.innerPath }), {
      method: 'POST',
      form: { operation, dst_repo: dst.repoId, dst_dir: dstDir },
    })
    const sourceName = driverFileName(source.innerPath)
    const targetName = driverFileName(dst.innerPath)
    if (sourceName !== targetName) {
      const movedInner = dstDir === '/' ? `/${sourceName}` : `${dstDir}/${sourceName}`
      await this.api(this.withQuery(`${this.repoPath(dst.repoId)}/file/`, { p: movedInner }), {
        method: 'POST',
        form: { operation: 'rename', newname: targetName },
      })
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.transfer(fromPath, toPath, 'move')
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.transfer(fromPath, toPath, 'copy')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      if (this.configuredRepo) {
        await this.api<SeafileRepo>(`${this.repoPath(this.configuredRepo)}/`)
      } else {
        await this.repos()
      }
      return { ok: true, message: 'Seafile is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Seafile is unavailable' }
    }
  }
}

export function createSeafileDriver(ctx: DriverContext): MountDriver {
  return new SeafileDriver(ctx)
}
