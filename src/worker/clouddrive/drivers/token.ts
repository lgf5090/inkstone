/**
 * Token lifecycle for the refresh/rotation drivers.
 *
 * Two layers keep a rotation from firing twice: an in-process single flight keyed by the storage id,
 * and a cross-request lease that the factory backs with a D1 compare-and-swap on the storage row.
 * The write-back is a compare-and-swap too, so the loser of a race adopts the winner's token instead
 * of overwriting it with a token that the provider has already rotated away.
 */
import { DriverError, type DriverContext } from './contract'
import {
  oauthProvider,
  refreshAccessToken,
  type OAuthProvider,
  type OAuthTokenSet,
} from './oauth'

const inflight = new Map<string, Promise<unknown>>()
const REFRESH_LEAD_MS = 60_000
const WAIT_ATTEMPTS = 12
const WAIT_INTERVAL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs `work` once per storage even when several requests need a token at the same time. A caller
 * that cannot claim the cross-request lease waits for the winner's credentials to appear; only after
 * the wait budget is exhausted does it fall through and refresh itself, so a stale lease cannot
 * wedge the storage forever.
 */
export async function singleFlightRefresh<T>(
  ctx: DriverContext,
  work: () => Promise<T>,
  recover: () => Promise<T | null>,
): Promise<T> {
  const key = `${ctx.storageId}:refresh`
  const running = inflight.get(key) as Promise<T> | undefined
  if (running) return running
  const promise = (async (): Promise<T> => {
    let ownsLease = true
    if (ctx.refreshLock) {
      try {
        ownsLease = await ctx.refreshLock.claim()
      } catch {
        ownsLease = true
      }
    }
    if (!ownsLease) {
      for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
        await sleep(WAIT_INTERVAL_MS)
        const recovered = await recover()
        if (recovered) return recovered
      }
    }
    try {
      return await work()
    } finally {
      if (ctx.refreshLock && ownsLease) await ctx.refreshLock.release().catch(() => undefined)
    }
  })()
  inflight.set(key, promise)
  try {
    return await promise
  } finally {
    inflight.delete(key)
  }
}

export interface OAuthSessionOptions {
  /** An access token shorter than this is refreshed before use. */
  refreshLeadMs?: number
}

/** The credential keys an OAuth session reads and writes. */
export function credentialField(ctx: DriverContext, key: string): string {
  return String(ctx.credentials[key] ?? '')
}

/**
 * An access/refresh pair stored in the vault. The session never persists a token without the
 * caller's previous values, so a compare-and-swap write can tell a concurrent refresh from its own.
 */
export class OAuthSession {
  private readonly provider: OAuthProvider

  constructor(
    private readonly ctx: DriverContext,
    providerId: string,
    private readonly options: OAuthSessionOptions = {},
  ) {
    const provider = oauthProvider(providerId)
    if (!provider) throw new Error(`No OAuth provider is registered for ${providerId}`)
    this.provider = provider
  }

  get accessToken(): string {
    return credentialField(this.ctx, 'accessToken')
  }

  get refreshToken(): string {
    return credentialField(this.ctx, 'refreshToken')
  }

  private clientId(): string {
    return credentialField(this.ctx, 'clientId') || this.provider.defaultClientId || ''
  }

  private clientSecret(): string {
    return credentialField(this.ctx, 'clientSecret') || this.provider.defaultClientSecret || ''
  }

  private expiresAt(): number {
    return Number(this.ctx.credentials.expiresAt) || 0
  }

  /** True when the cached token is usable without touching the provider. */
  private usable(): boolean {
    if (!this.accessToken) return false
    const expiresAt = this.expiresAt()
    if (!expiresAt) return true
    return expiresAt - Date.now() > (this.options.refreshLeadMs ?? REFRESH_LEAD_MS)
  }

  /** Returns a usable access token, refreshing once when it is missing or explicitly invalidated. */
  async token(force = false): Promise<string> {
    if (!force && this.usable()) return this.accessToken
    if (!this.refreshToken) {
      if (!force && this.accessToken) return this.accessToken
      throw DriverError.auth(
        `${this.provider.id} has no refresh token; connect the storage again from the storage settings.`,
      )
    }
    const beforeAccess = this.accessToken
    return await singleFlightRefresh(
      this.ctx,
      async () => await this.rotate(),
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = this.accessToken
        return current && current !== beforeAccess ? current : null
      },
    )
  }

  /** Drops the cached access token so the next call refreshes; the refresh token is kept. */
  invalidate(): void {
    this.ctx.credentials.accessToken = ''
    this.ctx.credentials.expiresAt = '0'
  }

  private async rotate(): Promise<string> {
    const clientId = this.clientId()
    if (!clientId) {
      throw DriverError.auth(
        `${this.provider.id} needs an OAuth client id. Register an application with the provider and paste its client id and secret.`,
      )
    }
    const previous = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
    }
    let tokens: OAuthTokenSet
    try {
      tokens = await refreshAccessToken(this.provider, {
        clientId,
        clientSecret: this.clientSecret() || undefined,
        refreshToken: previous.refreshToken,
      })
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
    const patch: Record<string, string> = {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresIn > 0 ? String(Date.now() + tokens.expiresIn * 1000) : '0',
    }
    if (tokens.refreshToken && tokens.refreshToken !== previous.refreshToken) {
      patch.refreshToken = tokens.refreshToken
    }
    const effective = await this.ctx.saveCredentials(patch, { expect: previous })
    Object.assign(this.ctx.credentials, effective)
    return credentialField(this.ctx, 'accessToken') || tokens.accessToken
  }

    /** Runs an API call with an access token, refreshing once when the provider rejects it. */
  async withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token()
    try {
      return await work(token)
    } catch (error) {
      if (!(error instanceof DriverError) || error.kind !== 'auth') throw error
      this.invalidate()
      try {
        return await work(await this.token(true))
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : 'The provider rejected the token'
        await this.ctx.markNeedsReauth(message)
        throw DriverError.auth(message)
      }
    }
  }
}

export interface ClientCredentialsOptions {
  tokenUrl: string
  scope: string
  clientId: string
  clientSecret: string
  extra?: Record<string, string>
}

/**
 * An application-identity token (`client_credentials`): there is no refresh token to rotate, the
 * token is simply requested again before its expiry. OneDrive application mounts and FeBBox use it.
 */
export class ClientCredentialsSession {
  private cachedToken = ''
  private expiresAt = 0

  constructor(
    private readonly ctx: DriverContext,
    private readonly options: ClientCredentialsOptions,
  ) {}

  get accessToken(): string {
    return this.cachedToken || credentialField(this.ctx, 'accessToken')
  }

  async token(force = false): Promise<string> {
    if (!force && this.accessToken && this.expiresAt - Date.now() > REFRESH_LEAD_MS) return this.accessToken
    return await singleFlightRefresh(
      this.ctx,
      async () => await this.fetchToken(),
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = credentialField(this.ctx, 'accessToken')
        return current && current !== this.cachedToken ? current : null
      },
    )
  }

  private async fetchToken(): Promise<string> {
    if (!this.options.clientId || !this.options.clientSecret) {
      throw DriverError.auth('This storage needs an application client id and secret')
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      scope: this.options.scope,
      ...(this.options.extra ?? {}),
    })
    let response: Response
    try {
      response = await fetch(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw DriverError.upstream(`The token endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 429) throw DriverError.rateLimited('The token endpoint is rate limiting requests')
    if (!response.ok) throw DriverError.auth(`The token endpoint refused the application credentials (HTTP ${response.status})`)
    const payload = await response.json().catch(() => null) as { access_token?: string; expires_in?: number } | null
    if (!payload?.access_token) throw DriverError.auth('The token endpoint returned no access token')
    this.cachedToken = payload.access_token
    this.expiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000
    const effective = await this.ctx.saveCredentials({
      accessToken: payload.access_token,
      expiresAt: String(this.expiresAt),
    }, { expect: { accessToken: credentialField(this.ctx, 'accessToken') } })
    this.cachedToken = String(effective.accessToken ?? this.cachedToken)
    return this.cachedToken
  }
}
