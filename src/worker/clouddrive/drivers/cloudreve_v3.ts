/**
 * Cloudreve V3 storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/cloudreve_v3`: session-cookie login through
 * `POST /api/v3/user/session`, path-addressed directory listings, download-link resolution through
 * `PUT /api/v3/file/download/<id>`, and the object endpoints for mkdir/rename/move/copy/delete.
 * Cloudreve V3 has no stateless upload endpoint, so uploading is reported as unsupported.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
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

const TIMEOUT_MS = 20_000
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inkstone-clouddrive'

interface CloudreveResponse {
  code?: number
  msg?: string
  data?: unknown
}

interface CloudreveObject {
  id: string
  name: string
  path?: string
  size?: number
  type?: string
  date?: string
  create_date?: string
}

interface CloudreveDirectory {
  parent?: string
  objects?: CloudreveObject[]
}

interface CloudreveSource {
  dirs: string[]
  items: string[]
}

function normalizeSessionToken(raw: string): string {
  const value = raw.trim()
  const fromCookie = /cloudreve-session=([^;]+)/.exec(value)
  return fromCookie ? fromCookie[1]!.trim() : value
}

function sessionCookieOf(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  for (const cookie of cookies) {
    const match = /cloudreve-session=([^;]+)/.exec(cookie)
    if (match) return match[1]!.trim()
  }
  const raw = response.headers.get('set-cookie') ?? ''
  const match = /cloudreve-session=([^;]+)/.exec(raw)
  return match ? match[1]!.trim() : ''
}

function entryOf(object: CloudreveObject): DriverEntry {
  const folder = object.type === 'dir'
  const date = object.date || object.create_date
  return {
    name: object.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(object.size) || 0,
    modifiedAt: date ? Date.parse(date) || 0 : 0,
    ref: object.id,
    ...(folder ? {} : { mime: driverEntryMime(object.name) }),
  }
}

async function responseFailure(response: Response, service: string): Promise<DriverError> {
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

class CloudreveV3Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('cloudreve_v3')!
  readonly capabilities = this.definition.capabilities
  private readonly address: string
  private readonly root: string
  private session = ''

  constructor(ctx: DriverContext) {
    super(ctx)
    this.address = this.configText('address').trim().replace(/\/+$/, '')
    try {
      this.root = driverPath(this.configText('rootPath', '/').trim() || '/')
    } catch {
      throw DriverError.invalid('The Cloudreve root path is invalid')
    }
  }

  private credential(key: string): string {
    return this.ctx.credentials[key] || this.configText(key)
  }

  protected async login(force: boolean): Promise<void> {
    const stored = normalizeSessionToken(this.credential('token'))
    const username = this.credential('username').trim()
    const password = this.credential('password')
    if (stored && !(force && username && password)) {
      this.session = stored
      return
    }
    if (!username || !password) {
      if (stored) {
        this.session = stored
        return
      }
      throw DriverError.auth('Cloudreve V3 needs a session token or a username and password')
    }
    if (!this.address) throw DriverError.invalid('Cloudreve needs a server address')

    const response = await this.request(`${this.address}/api/v3/user/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
      body: JSON.stringify({ username, password, captchaCode: '' }),
    })
    const payload = await response.json().catch(() => null) as CloudreveResponse | null
    if (!payload || payload.code !== 0) {
      throw DriverError.auth(`Cloudreve sign-in failed: ${payload?.msg ?? 'no response'}`)
    }
    const cookie = sessionCookieOf(response)
    if (!cookie) throw DriverError.auth('Cloudreve sign-in returned no session cookie')
    this.session = cookie
    await this.saveCredential({ token: cookie })
  }

  private physical(path: string): string {
    const clean = driverPath(path)
    if (this.root === '/') return clean
    return clean === '/' ? this.root : `${this.root}${clean}`
  }

  private directoryPath(uri: string): string {
    const segments = uri.split('/').filter(Boolean)
    if (segments.length === 0) return '/directory/'
    return `/directory/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
  }

  private codeFailure(payload: CloudreveResponse): DriverError | null {
    const code = Number(payload.code)
    if (code === 0) return null
    const message = payload.msg || `Cloudreve answered code ${String(payload.code)}`
    if (code === 401 || code === 403) return DriverError.auth(message)
    if (code === 404) return DriverError.notFound(message)
    if (code === 429) return DriverError.rateLimited(message)
    return DriverError.upstream(message)
  }

  private async api<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return await this.withAuth(async () => {
      const headers: Record<string, string> = {
        Cookie: `cloudreve-session=${this.session}`,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const url = `${this.address}/api/v3${path}`
      const bodyText = body === undefined ? undefined : JSON.stringify(body)
      // HttpOptions only names the four methods the JSON APIs use; Cloudreve's object mutations
      // are PATCH, so that one goes through a local fetch with the same error mapping.
      const response = method === 'PATCH'
        ? await this.rawPatch(url, headers, bodyText)
        : await this.request(url, { method, headers, body: bodyText })

      const refreshed = sessionCookieOf(response)
      if (refreshed && refreshed !== this.session) {
        this.session = refreshed
        await this.saveCredential({ token: refreshed })
      }

      const payload = await response.json().catch(() => null) as CloudreveResponse | null
      if (!payload) return {} as T
      const failure = this.codeFailure(payload)
      if (failure) throw failure
      return payload.data as T
    })
  }

  private async rawPatch(url: string, headers: Record<string, string>, body?: string): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'PATCH',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw DriverError.upstream(
        `Cloudreve could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) throw await responseFailure(response, 'Cloudreve')
    return response
  }

  private async listObjects(uri: string): Promise<CloudreveObject[]> {
    const data = await this.api<CloudreveDirectory>('GET', this.directoryPath(uri))
    return data?.objects ?? []
  }

  private async findObject(uri: string): Promise<CloudreveObject> {
    if (uri === '/') throw DriverError.invalid('The root has no directory entry')
    const parent = driverParentPath(uri)
    const name = driverFileName(uri)
    const objects = await this.listObjects(parent)
    const found = objects.find((object) => object.name === name)
    if (!found) throw DriverError.notFound(`Cloudreve object not found: ${name}`)
    return found
  }

  private async sourceOf(uri: string): Promise<CloudreveSource> {
    const object = await this.findObject(uri)
    return object.type === 'dir'
      ? { dirs: [object.id], items: [] }
      : { dirs: [], items: [object.id] }
  }

  async list(path: string): Promise<DriverListResult> {
    const uri = this.physical(path)
    const objects = await this.listObjects(uri)
    return { entries: objects.map(entryOf), cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const uri = this.physical(path)
    if (uri === '/') return { name: '/', kind: 'folder', size: 0, modifiedAt: 0, ref: '/' }
    return entryOf(await this.findObject(uri))
  }

  private async downloadUrl(id: string): Promise<string> {
    const raw = await this.api<string>('PUT', `/file/download/${encodeURIComponent(id)}`)
    const link = typeof raw === 'string' ? raw.trim() : ''
    if (!link) throw DriverError.upstream('Cloudreve returned an empty download address')
    if (link.startsWith('/')) return `${this.address}${link}`
    if (!/^https?:/i.test(link)) return new URL(link, `${this.address}/`).toString()
    return link
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const uri = this.physical(path)
    const object = await this.findObject(uri)
    if (object.type === 'dir') throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadUrl(object.id)
    let response: Response
    try {
      response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Referer: this.address,
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw DriverError.upstream(
        `The Cloudreve download could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 200 || response.status === 206) return response
    throw await responseFailure(response, 'Cloudreve download')
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('Direct put not supported')
  }

  async mkdir(path: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') return
    await this.api('PUT', '/directory', { path: uri })
  }

  async rename(path: string, newName: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') throw DriverError.invalid('The mount root cannot be renamed')
    const target = driverPath(driverChildPath(driverParentPath(uri), newName))
    if (target === uri) return
    const source = await this.sourceOf(uri)
    await this.api('PATCH', '/object/rename', {
      action: 'rename',
      new_name: driverFileName(target),
      src: source,
    })
  }

  private async relocate(path: string, destination: string, copy: boolean): Promise<void> {
    const uri = this.physical(path)
    const target = this.physical(destination)
    if (uri === '/' || target === '/') throw DriverError.invalid('The mount root cannot be transferred')
    if (uri === target) return
    const source = await this.sourceOf(uri)
    const sourceDir = driverParentPath(uri)
    const targetDir = driverParentPath(target)
    if (copy) {
      await this.api('POST', '/object/copy', { src_dir: sourceDir, dst: targetDir, src: source })
    } else {
      await this.api('PATCH', '/object', { action: 'move', src_dir: sourceDir, dst: targetDir, src: source })
    }
    if (driverFileName(uri) !== driverFileName(target)) {
      await this.api('PATCH', '/object/rename', {
        action: 'rename',
        new_name: driverFileName(target),
        src: source,
      })
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, false)
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, true)
  }

  async remove(path: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') throw DriverError.invalid('The mount root cannot be deleted')
    const source = await this.sourceOf(uri)
    await this.api('DELETE', '/object', source)
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.listObjects('/')
      return { ok: true, message: 'Cloudreve V3 is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Cloudreve V3 is unavailable' }
    }
  }
}

export function createCloudreveV3Driver(ctx: DriverContext): MountDriver {
  return new CloudreveV3Driver(ctx)
}
