/**
 * Lenovo personal NAS share driver (read-only).
 *
 * Ported from the reference implementation at
 * `OpenList-Worker/src/backend/drivers/lenovonas_share`: the share code and password are exchanged
 * for a short-lived `stoken`, which then authorizes the folder listing and the file download link.
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

const DEFAULT_HOST = 'https://siot-share.lenovo.com.cn'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inkstone-clouddrive'
const PAGE_SIZE = 5000

interface LenovoResponse<T> {
  result?: boolean
  error?: { msg?: string }
  data?: T
}

interface LenovoFile {
  name: string
  size: number
  path: string
  /** `dir` for a folder; anything else is a file. */
  type: string
  time: number
  chtime: number
}

interface LenovoAccess {
  stoken: string
  expires_in: number
}

interface LenovoList {
  list: LenovoFile[]
}

interface LenovoLink {
  param?: { dtoken?: string }
}

class LenovoNasShareDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('lenovonas_share')!
  readonly capabilities = this.definition.capabilities
  private stoken = ''
  private expiresAt = 0
  private host = DEFAULT_HOST

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private shareId(): string {
    const raw = this.configText('shareId').trim()
    if (!raw) return ''
    return raw.split('/').filter(Boolean).pop() ?? ''
  }

  private sharePassword(): string {
    return this.ctx.credentials.sharePwd ?? this.configText('sharePwd')
  }

  protected async login(_force: boolean): Promise<void> {
    const code = this.shareId()
    if (!code) throw DriverError.auth('Lenovo NAS Share needs the shareId copied from the share link.')
    this.host = this.configText('host', DEFAULT_HOST).trim().replace(/\/+$/, '') || DEFAULT_HOST
    const query = new URLSearchParams({ code, password: this.sharePassword() })
    const data = await this.api<LenovoAccess>(
      `${this.host}/oneproxy/api/share/v1/access?${query.toString()}`,
      true,
    )
    this.stoken = data?.stoken ?? ''
    if (!this.stoken) throw DriverError.auth('Lenovo NAS Share did not return a session token.')
    const expires = Number(data?.expires_in) || 3600
    this.expiresAt = Date.now() + expires * 1000 - 60_000
  }

  private headers(): Record<string, string> {
    return {
      origin: DEFAULT_HOST,
      referer: `${DEFAULT_HOST}/`,
      'user-agent': USER_AGENT,
      platform: 'web',
      'app-version': '3',
    }
  }

  private async api<T>(url: string, authFailure = false): Promise<T> {
    const response = await this.request(url, {
      headers: this.headers(),
      retries: 0,
      timeoutMs: 30_000,
    })
    const payload = await response.json().catch(() => null) as LenovoResponse<T> | null
    if (!payload || payload.result !== true) {
      const message = payload?.error?.msg || 'The Lenovo NAS share request failed'
      throw authFailure ? DriverError.auth(message) : DriverError.upstream(message)
    }
    return payload.data as T
  }

  /** Throwing here makes `withAuth` refresh the token exactly once before it gives up. */
  private ensureSession(): void {
    if (!this.stoken || Date.now() >= this.expiresAt) {
      throw DriverError.auth('The Lenovo NAS Share session expired.')
    }
  }

  private upstreamPath(input: string): string {
    const clean = driverPath(input)
    const root = driverPath(this.configText('rootPath', '/'))
    if (root === '/') return clean
    return clean === '/' ? root : `${root}${clean}`
  }

  private entry(file: LenovoFile): DriverEntry {
    const folder = file.type === 'dir'
    return {
      name: file.name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(file.size) || 0,
      modifiedAt: Number(file.chtime || file.time) * 1000 || 0,
      ref: file.path || file.name,
      mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
    }
  }

  private async listFiles(path: string): Promise<LenovoFile[]> {
    this.ensureSession()
    const query = new URLSearchParams({
      code: this.shareId(),
      num: String(PAGE_SIZE),
      stoken: this.stoken,
      path,
    })
    const data = await this.api<LenovoList>(
      `${this.host}/oneproxy/api/share/v1/files?${query.toString()}`,
    )
    return data?.list ?? []
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      this.ensureSession()
      const upstream = this.upstreamPath(clean)
      const query = new URLSearchParams({
        code: this.shareId(),
        num: String(Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))),
        stoken: this.stoken,
        path: upstream,
      })
      const data = await this.api<LenovoList>(
        `${this.host}/oneproxy/api/share/v1/files?${query.toString()}`,
      )
      const files = data?.list ?? []
      return {
        entries: files.map((file) => this.entry(file)),
        cursor: null,
        truncated: false,
      }
    })
  }

  private async resolveEntry(path: string): Promise<{ file: LenovoFile | null; entry: DriverEntry }> {
    const clean = driverPath(path)
    if (clean === '/' || this.upstreamPath(clean) === '/') {
      return {
        file: null,
        entry: { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '/' },
      }
    }
    const upstream = this.upstreamPath(clean)
    const name = driverFileName(upstream)
    const parent = driverParentPath(upstream)
    const files = await this.listFiles(parent)
    const found = files.find((file) => file.name === name)
    if (!found) throw DriverError.notFound(`Lenovo NAS Share has no entry named ${name}`)
    return { file: found, entry: this.entry(found) }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => (await this.resolveEntry(clean)).entry)
  }

  private async downloadUrl(file: LenovoFile): Promise<string> {
    this.ensureSession()
    const query = new URLSearchParams({
      code: this.shareId(),
      stoken: this.stoken,
      path: file.path.startsWith('/') ? file.path : `/${file.path}`,
    })
    const data = await this.api<LenovoLink>(
      `${this.host}/oneproxy/api/share/v1/file/link?${query.toString()}`,
    )
    const dtoken = data?.param?.dtoken ?? ''
    if (!dtoken) throw DriverError.upstream('The Lenovo NAS Share returned no download token.')
    return `${this.host}/oneproxy/api/share/v1/file/download?code=${encodeURIComponent(this.shareId())}&dtoken=${encodeURIComponent(dtoken)}`
  }

  private async downloadFailure(response: Response): Promise<never> {
    const text = await response.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(text) as { message?: unknown; msg?: unknown; error?: unknown }
      if (typeof parsed.message === 'string') message = parsed.message
      else if (typeof parsed.msg === 'string') message = parsed.msg
      else if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      message = text.slice(0, 200)
    }
    const suffix = message ? `: ${message}` : ''
    if (response.status === 401 || response.status === 403) {
      throw DriverError.auth(`The Lenovo NAS Share refused the download (HTTP ${response.status}${suffix})`)
    }
    if (response.status === 404) throw DriverError.notFound(`Not found upstream (HTTP 404${suffix})`)
    if (response.status === 429) throw DriverError.rateLimited(`The Lenovo NAS Share is rate limiting downloads${suffix}`)
    throw DriverError.upstream(`The Lenovo NAS Share download failed (HTTP ${response.status}${suffix})`)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const { file, entry } = await this.resolveEntry(clean)
      if (!file || entry.kind !== 'file') {
        throw DriverError.unsupported('A folder cannot be read as a file')
      }
      const link = await this.downloadUrl(file)
      const response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          ...this.headers(),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await this.downloadFailure(response)
      }
      return response
    })
  }

  async upload(): Promise<void> {
    throw DriverError.unsupported('Lenovo NAS Share is read-only')
  }

  async mkdir(): Promise<void> {
    throw DriverError.unsupported('Lenovo NAS Share is read-only')
  }

  async rename(): Promise<void> {
    throw DriverError.unsupported('Lenovo NAS Share is read-only')
  }

  async move(): Promise<void> {
    throw DriverError.unsupported('Lenovo NAS Share is read-only')
  }

  async remove(): Promise<void> {
    throw DriverError.unsupported('Lenovo NAS Share is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const files = await this.listFiles(driverPath(this.configText('rootPath', '/')))
      return { ok: true, message: `Lenovo NAS Share is reachable · ${files.length} entries at the root` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Lenovo NAS Share is unavailable' }
    }
  }
}

export function createLenovoNasShareDriver(ctx: DriverContext): MountDriver {
  return new LenovoNasShareDriver(ctx)
}
