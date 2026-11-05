/**
 * The driver contract every CloudDrive storage implementation speaks.
 *
 * A driver only knows paths relative to its mount ("/photos/2024.jpg"), never D1 rows or HTTP. The
 * worker layer owns visibility, quotas and meta rules; a driver owns one upstream service.
 */
import type {
  CloudDriveDriverCapabilities,
  CloudDriveDriverDefinition,
} from '@shared/clouddrive/drivers'

export class DriverError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate_limit' | 'not_found' | 'unsupported' | 'invalid' | 'upstream',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'DriverError'
  }

  static auth(message = 'The storage needs to be authorized again'): DriverError {
    return new DriverError('auth', message)
  }

  static notFound(message = 'Not found'): DriverError {
    return new DriverError('not_found', message)
  }

  static unsupported(message = 'This storage does not support this operation'): DriverError {
    return new DriverError('unsupported', message)
  }

  static invalid(message = 'The path is invalid'): DriverError {
    return new DriverError('invalid', message)
  }

  static upstream(message: string, retryAfterMs?: number): DriverError {
    return new DriverError('upstream', message, retryAfterMs)
  }

  static rateLimited(message = 'The upstream service is rate limiting requests', retryAfterMs?: number): DriverError {
    return new DriverError('rate_limit', message, retryAfterMs)
  }
}

export interface DriverEntry {
  name: string
  kind: 'folder' | 'file'
  size: number
  modifiedAt: number
  /** The driver's native id, used to read without resolving the display path again. */
  ref?: string
  mime?: string
}

export interface DriverListOptions {
  /** One-based page; omitted means "walk pages until the cap". */
  page?: number
  pageSize?: number
  search?: string
}

export interface DriverListResult {
  entries: DriverEntry[]
  /** The cursor for the next page when the driver has one, or null at the end. */
  cursor: string | null
  truncated: boolean
}

export interface DriverUploadOptions {
  size: number
  contentType?: string
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
}

/** Another mount owned by the same user, already checked for status and cycles. */
export interface ResolvedMount {
  mountId: string
  mountName: string
  mountPath: string
  readOnly: boolean
  driver: MountDriver
}

export interface DriverContext {
  userId: string
  storageId: string
  type: string
  config: Record<string, unknown>
  credentials: Record<string, string>
  /** Persists a rotated token or cookie; the caller re-encrypts it in the vault. */
  saveCredentials: (patch: Record<string, string>) => Promise<void>
  /** Marks the storage as needing the owner's attention instead of retrying forever. */
  markNeedsReauth: (message: string) => Promise<void>
  /** Seconds a direct link stays valid, taken from the mount's `signExpires`. */
  directLinkExpires?: number
  /** Resolves one of this user's enabled mounts by mount path or mount id. */
  resolveMount?: (reference: string) => Promise<ResolvedMount>
  /** Writes declared `config` fields back to the current storage row. */
  saveConfig?: (patch: Record<string, unknown>) => Promise<void>
  /** The deployment's primary R2 binding, used by the `r2` binding mode. */
  r2?: R2Bucket
  /** The mount this driver instance is serving, when the caller knows it. */
  mountId?: string
  mountPath?: string
}

export interface MountDriver {
  readonly definition: CloudDriveDriverDefinition
  readonly capabilities: CloudDriveDriverCapabilities

  list(path: string, options?: DriverListOptions): Promise<DriverListResult>
  stat(path: string): Promise<DriverEntry>
  /** A streaming response with the upstream Range answer, or a 200 body. */
  read(path: string, range?: string | null): Promise<Response>
  upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void>
  mkdir(path: string): Promise<void>
  rename(path: string, newName: string): Promise<void>
  move(fromPath: string, toPath: string): Promise<void>
  copy?(fromPath: string, toPath: string): Promise<void>
  remove(path: string): Promise<void>
  directLink?(path: string): Promise<string | null>
  /** A reachability/auth probe used by the admin "test" button. */
  test(): Promise<{ ok: boolean; message: string }>
}

export function driverEntryMime(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(extension)) {
    return `image/${extension === 'jpg' ? 'jpeg' : extension}`
  }
  if (['mp4', 'webm', 'mov'].includes(extension)) return `video/${extension}`
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(extension)) return `audio/${extension}`
  if (extension === 'pdf') return 'application/pdf'
  if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml'].includes(extension)) return 'text/plain'
  return 'application/octet-stream'
}

export function asBytes(body: Uint8Array | ReadableStream): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Promise.resolve(body)
  return new Response(body).arrayBuffer().then((buffer) => new Uint8Array(buffer))
}
