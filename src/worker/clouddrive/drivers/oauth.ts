/**
 * OAuth 2.0 plumbing shared by the authorization-code drivers.
 *
 * The Workers runtime cannot listen on a localhost port, so every driver registers one real callback
 * on this deployment: `/api/clouddrive/oauth/<driver>/callback`. The authorize step stores a random
 * state in `OAUTH_KV`; the callback reads it back, exchanges the code and writes the rotated tokens
 * through the credential vault.
 */
import { DriverError } from './contract'

export interface OAuthProvider {
  id: string
  authorizeUrl: string
  tokenUrl: string
  scopes: readonly string[]
  /** Extra query parameters an authorize request needs (`access_type=offline`, `prompt=consent`). */
  authorizeParams?: Readonly<Record<string, string>>
  /** Sent with both the code exchange and the refresh, e.g. a Dropbox token access type. */
  tokenParams?: Readonly<Record<string, string>>
  /** `body` posts client credentials as form fields; `basic` uses an Authorization header. */
  tokenAuth?: 'body' | 'basic'
  pkce?: boolean
  /** Some providers publish a application used by the reference implementation. */
  defaultClientId?: string
  defaultClientSecret?: string
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProvider>> = {
  onedrive: {
    id: 'onedrive',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'Files.ReadWrite.All', 'User.Read'],
    tokenAuth: 'body',
  },
  dropbox: {
    id: 'dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: [],
    authorizeParams: { token_access_type: 'offline', force_reapprove: 'true' },
    tokenParams: { token_access_type: 'offline' },
    tokenAuth: 'body',
  },
  google_drive: {
    id: 'google_drive',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
    defaultClientId: '202264815644-2n82p2e49c7o6026u87j9e22v1n25c27.apps.googleusercontent.com',
    defaultClientSecret: 'GOCSPX-4bH5Kx3s_89_j6j2x-2x3-8x',
  },
  google_photo: {
    id: 'google_photo',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuth: 'body',
    defaultClientId: '202264815644-2n82p2e49c7o6026u87j9e22v1n25c27.apps.googleusercontent.com',
    defaultClientSecret: 'GOCSPX-4bH5Kx3s_89_j6j2x-2x3-8x',
  },
  yandex: {
    id: 'yandex',
    authorizeUrl: 'https://oauth.yandex.com/authorize',
    tokenUrl: 'https://oauth.yandex.com/token',
    scopes: ['cloud_api:disk.read', 'cloud_api:disk.write'],
    tokenAuth: 'body',
  },
  aliyundrive_open: {
    id: 'aliyundrive_open',
    authorizeUrl: 'https://openapi.alipan.com/oauth/authorize',
    tokenUrl: 'https://openapi.alipan.com/oauth/access_token',
    scopes: ['user:base', 'file:all:read', 'file:all:write'],
    tokenAuth: 'body',
    defaultClientId: '25ab4837190e48718a28f80073574a4d',
  },
  baidu_netdisk: {
    id: 'baidu_netdisk',
    authorizeUrl: 'https://openapi.baidu.com/oauth/2.0/authorize',
    tokenUrl: 'https://openapi.baidu.com/oauth/2.0/token',
    scopes: ['basic', 'netdisk'],
    tokenAuth: 'body',
  },
}

export function oauthProvider(id: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[id] ?? null
}

export function oauthCallbackPath(driverId: string): string {
  return `/api/clouddrive/oauth/${driverId}/callback`
}

export function oauthCallbackUrl(origin: string, driverId: string): string {
  return `${origin.replace(/\/$/, '')}${oauthCallbackPath(driverId)}`
}

export function oauthDriverIds(): readonly string[] {
  return Object.keys(OAUTH_PROVIDERS)
}

export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return base64Url(bytes)
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface AuthorizeInput {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge?: string
}

export function buildAuthorizeUrl(provider: OAuthProvider, input: AuthorizeInput): string {
  const url = new URL(provider.authorizeUrl)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', input.state)
  if (provider.scopes.length > 0) url.searchParams.set('scope', provider.scopes.join(' '))
  for (const [key, value] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(key, value)
  if (input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

interface TokenRequestInput {
  clientId: string
  clientSecret?: string
  refreshToken?: string
  code?: string
  redirectUri?: string
  codeVerifier?: string
}

function tokenRequest(provider: OAuthProvider, input: TokenRequestInput): URLSearchParams {
  const form = new URLSearchParams()
  form.set('client_id', input.clientId)
  if (input.clientSecret && provider.tokenAuth !== 'basic') form.set('client_secret', input.clientSecret)
  if (input.refreshToken) {
    form.set('grant_type', 'refresh_token')
    form.set('refresh_token', input.refreshToken)
  } else {
    form.set('grant_type', 'authorization_code')
    form.set('code', input.code ?? '')
    form.set('redirect_uri', input.redirectUri ?? '')
    if (input.codeVerifier) form.set('code_verifier', input.codeVerifier)
  }
  for (const [key, value] of Object.entries(provider.tokenParams ?? {})) form.set(key, value)
  return form
}

function basicAuth(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${btoa(raw)}`
}

async function readTokenSet(response: Response): Promise<OAuthTokenSet> {
  const text = await response.text().catch(() => '')
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    throw DriverError.rateLimited(
      'The OAuth provider is rate limiting token requests',
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw DriverError.auth(`The OAuth provider refused the authorization (HTTP ${response.status})`)
  }
  if (response.status === 404) throw DriverError.notFound('The OAuth token endpoint was not found')
  if (!response.ok) {
    let message = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown }
      if (typeof parsed.error_description === 'string') message = parsed.error_description
      else if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // A non-JSON body is already the best message available.
    }
    if (response.status === 400) throw DriverError.auth(`The OAuth token exchange failed: ${message}`)
    throw DriverError.upstream(`The OAuth provider answered HTTP ${response.status}: ${message}`)
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw DriverError.upstream('The OAuth provider returned a non-JSON token response')
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) throw DriverError.auth(`The OAuth provider returned no access token: ${text.slice(0, 120)}`)
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    expiresIn: Number(payload.expires_in) || 0,
  }
}

async function postToken(provider: OAuthProvider, form: URLSearchParams, headers: Record<string, string> = {}): Promise<OAuthTokenSet> {
  let response: Response
  try {
    response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw DriverError.upstream(`The OAuth provider could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  return await readTokenSet(response)
}

export async function exchangeAuthorizationCode(
  provider: OAuthProvider,
  input: TokenRequestInput & { code: string; redirectUri: string },
): Promise<OAuthTokenSet> {
  const headers: Record<string, string> = {}
  if (provider.tokenAuth === 'basic' && input.clientSecret) {
    headers.Authorization = basicAuth(input.clientId, input.clientSecret)
  }
  return await postToken(provider, tokenRequest(provider, input), headers)
}

export async function refreshAccessToken(
  provider: OAuthProvider,
  input: TokenRequestInput & { refreshToken: string },
): Promise<OAuthTokenSet> {
  const headers: Record<string, string> = {}
  if (provider.tokenAuth === 'basic' && input.clientSecret) {
    headers.Authorization = basicAuth(input.clientId, input.clientSecret)
  }
  return await postToken(provider, tokenRequest(provider, input), headers)
}
