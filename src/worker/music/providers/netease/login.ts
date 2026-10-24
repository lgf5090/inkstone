/**
 * Login flows shared by the native and upstream-backed providers.
 *
 * The QR image is drawn by the browser from the URL this returns; no placeholder bitmap is produced
 * here. A confirmed scan leaves the new cookie in the transport (the caller persists it encrypted),
 * and polling leaks nothing before that point.
 */
import type { MusicAccount } from '../../../../shared/music/model'
import type { MusicAccountStatus } from '../../../../shared/music/api'
import {
  MusicProviderError,
  type MusicLoginSession,
  type MusicQrChallenge,
  type MusicQrPollResult,
  type MusicQrStatus,
} from '../types'

export type NeteaseLoginRequest =
  | { kind: 'qr-key' }
  | { kind: 'qr-check'; key: string }
  | { kind: 'logout' }

export interface NeteaseLoginTransport {
  request(input: NeteaseLoginRequest): Promise<Record<string, unknown>>
  readAccount(): Promise<MusicAccount | null>
  /** The cookie currently held by the provider, already merged with any `Set-Cookie` it received. */
  currentCookie(): string
  absorbCookie(cookie: string | string[]): void
  resetCookie(): void
}

const QR_TTL_MS = 5 * 60 * 1000

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function codeOf(body: Record<string, unknown>, fallback: number): number {
  const parsed = Number(body.code)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** The key sits under `data` in the reference server's wrapper and at the top level upstream. */
export function qrKeyFrom(body: Record<string, unknown>): string {
  return text(record(body.data).unikey) || text(body.unikey)
}

export function qrUrl(key: string): string {
  return `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
}

export function qrStatusFrom(code: number): MusicQrStatus | null {
  if (code === 800) return 'expired'
  if (code === 801) return 'waiting'
  if (code === 802) return 'scanned'
  if (code === 803) return 'confirmed'
  return null
}

export class NeteaseLogin {
  constructor(private readonly transport: NeteaseLoginTransport) {}

  async createQr(): Promise<MusicQrChallenge> {
    const body = await this.transport.request({ kind: 'qr-key' })
    const key = qrKeyFrom(body)
    if (!key) {
      throw new MusicProviderError(502, 'upstream_error', 'Netease did not return a QR key', body)
    }
    return { key, url: qrUrl(key), expiresAt: Date.now() + QR_TTL_MS }
  }

  async pollQr(key: string): Promise<MusicQrPollResult> {
    const body = await this.transport.request({ kind: 'qr-check', key })
    const code = codeOf(body, 0)
    const status = qrStatusFrom(code)
    if (!status) {
      throw new MusicProviderError(502, 'upstream_error', `Netease QR poll answered ${code}`, body)
    }
    const message = text(body.message) || status
    if (status !== 'confirmed') return { status, message, cookie: '', account: null }

    const account = await this.transport.readAccount()
    if (!account) {
      throw new MusicProviderError(
        502,
        'upstream_error',
        'Netease confirmed the scan but the account profile could not be read',
        body,
      )
    }
    return { status, message, cookie: this.transport.currentCookie(), account }
  }

  async connectCookie(cookie: string): Promise<MusicLoginSession> {
    this.transport.resetCookie()
    this.transport.absorbCookie(cookie)
    const account = await this.transport.readAccount()
    if (!account) {
      this.transport.resetCookie()
      throw new MusicProviderError(401, 'auth_required', 'The supplied cookie is not a Netease session')
    }
    return { account, cookie: this.transport.currentCookie() }
  }

  async status(): Promise<MusicAccountStatus> {
    const account = await this.transport.readAccount()
    return { account }
  }

  async logout(): Promise<void> {
    try {
      await this.transport.request({ kind: 'logout' })
    } finally {
      this.transport.resetCookie()
    }
  }
}
