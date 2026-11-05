/**
 * KodBox storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/kodbox`: form-based login that returns an
 * `accessToken`, explorer form endpoints for listing and mutations, the `fileOut` download URL,
 * and multipart uploads. KodBox answers HTTP 200 with a JSON `code`, so token expiry and request
 * failures are classified from the body as well as the status.
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
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const TIMEOUT_MS = 30_000

interface KodboxPayload {
  code?: boolean | string
  info?: string | boolean
  data?: unknown
}

interface KodboxEntry {
  path?: string
  name: string
  createTime?: number
  modifyTime?: number
  size?: number
  type?: string
}

interface KodboxListing {
  folderList?: KodboxEntry[]
  fileList?: KodboxEntry[]
}

async function responseFailure(response: Response, service: string): Promise<DriverError> {
  const body = await response.text().catch(() => '')
  let message = ''
  try {
    const parsed = JSON.parse(body) as { message?: unknown; msg?: unknown; error?: unknown; data?: unknown }
    const candidate = parsed.message ?? parsed.msg ?? parsed.error ?? parsed.data
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

function entryOf(item: KodboxEntry): DriverEntry {
  const folder = item.type === 'folder'
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(item.size) || 0,
    modifiedAt: item.modifyTime ? item.modifyTime * 1000 : 0,
    ...(item.path ? { ref: item.path } : {}),
    ...(folder ? {} : { mime: driverEntryMime(item.name) }),
  }
}

class KodboxDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('kodbox')!
  readonly capabilities = this.definition.capabilities
  private readonly address: string
  private readonly root: string
  private accessToken = ''

  constructor(ctx: DriverContext) {
    super(ctx)
    this.address = this.configText('address').trim().replace(/\/+$/, '')
    try {
      this.root = driverPath(this.configText('rootPath', '/').trim() || '/')
    } catch {
      throw DriverError.invalid('The KodBox root path is invalid')
    }
  }

  private credential(key: string): string {
    return this.ctx.credentials[key] || this.configText(key)
  }

  protected async login(): Promise<void> {
    const username = this.credential('username').trim()
    const password = this.credential('password')
    if (!username || !password) throw DriverError.auth('KodBox needs a username and password')
    if (!this.address) throw DriverError.invalid('KodBox needs a server address')

    const response = await this.request(`${this.address}/?user/index/loginSubmit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ name: username, password }).toString(),
    })
    const payload = await response.json().catch(() => null) as KodboxPayload | null
    if (!payload || payload.code === false) {
      throw DriverError.auth(`KodBox sign-in failed: ${String(payload?.data ?? 'no response')}`)
    }
    const token = typeof payload.info === 'string' ? payload.info : ''
    if (!token) throw DriverError.auth('KodBox sign-in returned no access token')
    this.accessToken = token
  }

  private physical(path: string): string {
    const clean = driverPath(path)
    if (this.root === '/') return clean
    return clean === '/' ? this.root : `${this.root}${clean}`
  }

  private codeFailure(payload: KodboxPayload): DriverError | null {
    const code = payload.code
    if (code === undefined || code === true || code === 'true') return null
    if (code === false) {
      return DriverError.upstream(String(payload.data ?? 'KodBox request failed'))
    }
    if (code === '10001') return DriverError.auth('KodBox access token expired')
    const numeric = Number(code)
    const message = typeof payload.data === 'string' ? payload.data : `KodBox answered code ${String(code)}`
    if (numeric === 401 || numeric === 403) return DriverError.auth(message)
    if (numeric === 404) return DriverError.notFound(message)
    if (numeric === 429) return DriverError.rateLimited(message)
    return DriverError.upstream(message)
  }

  private async api<T>(endpoint: string, form: Record<string, string>): Promise<T> {
    return await this.withAuth(async () => {
      const body = new URLSearchParams({ accessToken: this.accessToken, ...form }).toString()
      const response = await this.request(`${this.address}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      })
      const payload = await response.json().catch(() => null) as KodboxPayload | null
      if (!payload) throw DriverError.upstream('KodBox returned an unexpected body')
      const failure = this.codeFailure(payload)
      if (failure) throw failure
      return payload.data as T
    })
  }

  async list(path: string): Promise<DriverListResult> {
    const full = this.physical(path)
    const listing = await this.api<KodboxListing>('/?explorer/list/path', { path: full })
    const items = [...(listing?.folderList ?? []), ...(listing?.fileList ?? [])]
    return { entries: items.map(entryOf), cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const full = this.physical(path)
    if (full === '/') return { name: '/', kind: 'folder', size: 0, modifiedAt: 0, ref: '/' }
    const parent = driverParentPath(full)
    const name = driverFileName(full)
    const listing = await this.api<KodboxListing>('/?explorer/list/path', { path: parent })
    const found = [...(listing?.folderList ?? []), ...(listing?.fileList ?? [])]
      .find((item) => item.name === name)
    if (!found) throw DriverError.notFound(`KodBox object not found: ${name}`)
    return entryOf(found)
  }

  private downloadUrl(full: string): string {
    return `${this.address}/?explorer/index/fileOut&path=${encodeURIComponent(full)}&download=1&accessToken=${encodeURIComponent(this.accessToken)}`
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const full = this.physical(path)
    if (full === '/') throw DriverError.unsupported('The mount root is a folder')
    return await this.withAuth(async () => {
      let response: Response
      try {
        response = await fetch(this.downloadUrl(full), {
          method: 'GET',
          redirect: 'follow',
          headers: range ? { Range: range } : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        throw DriverError.upstream(
          `The KodBox download could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (response.status === 200 || response.status === 206) return response
      throw await responseFailure(response, 'KodBox download')
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const full = this.physical(path)
    if (full === '/') throw DriverError.invalid('A file name is required')
    const bytes = await asBytes(body)
    const parent = driverParentPath(full)
    const name = driverFileName(full)

    await this.withAuth(async () => {
      const form = new FormData()
      form.append('accessToken', this.accessToken)
      form.append('path', parent)
      form.append('file', new Blob([bytes], { type: options.contentType || 'application/octet-stream' }), name)
      let response: Response
      try {
        response = await fetch(`${this.address}/?explorer/upload/fileUpload`, {
          method: 'POST',
          body: form,
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        throw DriverError.upstream(
          `The KodBox upload could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!response.ok) throw await responseFailure(response, 'KodBox upload')
      const payload = await response.json().catch(() => null) as KodboxPayload | null
      if (payload) {
        const failure = this.codeFailure(payload)
        if (failure) throw failure
      }
    })
    options.onProgress?.(bytes.byteLength, options.size || bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const full = this.physical(path)
    if (full === '/') return
    await this.api('/?explorer/index/mkdir', { path: full })
  }

  async rename(path: string, newName: string): Promise<void> {
    const full = this.physical(path)
    if (full === '/') throw DriverError.invalid('The mount root cannot be renamed')
    await this.api('/?explorer/index/pathRename', { path: full, newName })
  }

  async remove(path: string): Promise<void> {
    const full = this.physical(path)
    if (full === '/') throw DriverError.invalid('The mount root cannot be deleted')
    await this.api('/?explorer/index/pathDelete', {
      dataArr: JSON.stringify([{ path: full, name: driverFileName(full) }]),
      shiftDelete: '1',
    })
  }

  private async relocate(path: string, destination: string, action: 'move' | 'copy'): Promise<void> {
    const full = this.physical(path)
    const target = this.physical(destination)
    if (full === '/' || target === '/') throw DriverError.invalid('The mount root cannot be transferred')
    const name = driverFileName(full)
    const dstDir = driverParentPath(target)
    const endpoint = action === 'move' ? '/?explorer/index/pathCuteTo' : '/?explorer/index/pathCopyTo'
    await this.api(endpoint, {
      dataArr: JSON.stringify([{ path: full, name }]),
      path: dstDir,
    })
    if (name !== driverFileName(target)) {
      const movedPath = dstDir === '/' ? `/${name}` : `${dstDir}/${name}`
      await this.api('/?explorer/index/pathRename', {
        path: movedPath,
        newName: driverFileName(target),
      })
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, 'move')
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, 'copy')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.api<KodboxListing>('/?explorer/list/path', { path: this.physical('/') })
      return { ok: true, message: 'KodBox is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'KodBox is unavailable' }
    }
  }
}

export function createKodboxDriver(ctx: DriverContext): MountDriver {
  return new KodboxDriver(ctx)
}
