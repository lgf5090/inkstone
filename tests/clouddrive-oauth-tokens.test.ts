// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OAUTH_PROVIDERS,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from '../src/worker/clouddrive/drivers/oauth'
import {
  ClientCredentialsSession,
  OAuthSession,
} from '../src/worker/clouddrive/drivers/token'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const STORAGE = 'storage-oauth'

function context(credentials: Record<string, string> = {}): DriverContext {
  const stored = { ...credentials }
  return {
    userId: 'user-a',
    storageId: STORAGE,
    type: 'onedrive',
    config: {},
    credentials: stored,
    saveCredentials: vi.fn(async (patch, options) => {
      if (options?.expect) {
        for (const [key, value] of Object.entries(options.expect)) {
          if ((stored[key] ?? '') !== value) return { ...stored }
        }
      }
      Object.assign(stored, patch)
      return { ...stored }
    }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OAuth authorize URLs', () => {
  it('carries the OneDrive client id, callback, state, scope and response type', () => {
    const url = buildAuthorizeUrl(OAUTH_PROVIDERS.onedrive!, {
      clientId: 'client-1',
      redirectUri: 'https://app.example/api/clouddrive/oauth/onedrive/callback',
      state: 'state-1',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('client_id')).toBe('client-1')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example/api/clouddrive/oauth/onedrive/callback')
    expect(parsed.searchParams.get('state')).toBe('state-1')
    expect(parsed.searchParams.get('scope')).toContain('Files.ReadWrite.All')
    expect(parsed.searchParams.get('scope')).toContain('offline_access')
  })

  it('asks Google for offline access and a consent prompt', () => {
    const url = new URL(buildAuthorizeUrl(OAUTH_PROVIDERS.google_drive!, {
      clientId: 'g-client',
      redirectUri: 'https://app.example/api/clouddrive/oauth/google_drive/callback',
      state: 'g-state',
      codeChallenge: 'challenge',
    }))
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge')).toBe('challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive')
  })

  it('asks Dropbox for an offline token', () => {
    const url = new URL(buildAuthorizeUrl(OAUTH_PROVIDERS.dropbox!, {
      clientId: 'd-client',
      redirectUri: 'https://app.example/api/clouddrive/oauth/dropbox/callback',
      state: 'd-state',
    }))
    expect(url.searchParams.get('token_access_type')).toBe('offline')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('OAuth token endpoints', () => {
  it('maps a refused code exchange to an auth error', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'invalid_grant', error_description: 'code expired' }, 400))
    await expect(exchangeAuthorizationCode(OAUTH_PROVIDERS.onedrive!, {
      code: 'bad',
      redirectUri: 'https://app.example/api/clouddrive/oauth/onedrive/callback',
      clientId: 'client-1',
      clientSecret: 'secret',
    })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('returns the rotated refresh token and expiry from a refresh', async () => {
    vi.stubGlobal('fetch', async () => json({
      access_token: 'a2', refresh_token: 'r2', expires_in: 3600,
    }))
    const tokens = await refreshAccessToken(OAUTH_PROVIDERS.dropbox!, {
      clientId: 'd-client', clientSecret: 'secret', refreshToken: 'r1',
    })
    expect(tokens.accessToken).toBe('a2')
    expect(tokens.refreshToken).toBe('r2')
    expect(tokens.expiresIn).toBe(3600)
  })

  it('maps 429 and 404 from the token endpoint', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }))
    await expect(refreshAccessToken(OAUTH_PROVIDERS.yandex!, {
      clientId: 'y', refreshToken: 'r1',
    })).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    await expect(refreshAccessToken(OAUTH_PROVIDERS.yandex!, {
      clientId: 'y', refreshToken: 'r1',
    })).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('token refresh single flight', () => {
  it('hits the token endpoint once for two concurrent refreshes and persists the rotation', async () => {
    const ctx = context({ refreshToken: 'r1', clientId: 'client-1', clientSecret: 'secret' })
    let tokenCalls = 0
    vi.stubGlobal('fetch', async () => {
      tokenCalls++
      return json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    })
    const session = new OAuthSession(ctx, 'onedrive')
    const [first, second] = await Promise.all([session.token(), session.token()])
    expect(first).toBe('a2')
    expect(second).toBe('a2')
    expect(tokenCalls).toBe(1)
    expect(ctx.credentials.refreshToken).toBe('r2')
    expect(ctx.saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a2', refreshToken: 'r2' }),
      { expect: { accessToken: '', refreshToken: 'r1' } },
    )
  })

  it('marks the storage for re-authorization when the refresh is refused', async () => {
    const ctx = context({ refreshToken: 'dead', clientId: 'client-1', clientSecret: 'secret' })
    ctx.markNeedsReauth = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ error: 'invalid_grant' }, 400))
    const session = new OAuthSession(ctx, 'onedrive')
    await expect(session.token()).rejects.toMatchObject({ kind: 'auth' })
    expect(ctx.markNeedsReauth).toHaveBeenCalled()
  })

  it('adopts the winner credentials when the compare-and-swap write loses', async () => {
    const ctx = context({ refreshToken: 'r1', clientId: 'client-1', clientSecret: 'secret' })
    ctx.saveCredentials = vi.fn(async () => ({
      accessToken: 'winner', refreshToken: 'winner-refresh', clientId: 'client-1', clientSecret: 'secret',
    }))
    vi.stubGlobal('fetch', async () => json({ access_token: 'loser', refresh_token: 'loser-refresh', expires_in: 3600 }))
    const session = new OAuthSession(ctx, 'onedrive')
    expect(await session.token()).toBe('winner')
  })

  it('requests a client-credentials token once and caches it', async () => {
    const ctx = context({ clientId: 'app-id', clientSecret: 'app-secret' })
    let tokenCalls = 0
    vi.stubGlobal('fetch', async () => {
      tokenCalls++
      return json({ access_token: 'app-token', expires_in: 3600 })
    })
    const session = new ClientCredentialsSession(ctx, {
      tokenUrl: 'https://login.example/token',
      scope: 'https://graph.microsoft.com/.default',
      clientId: 'app-id',
      clientSecret: 'app-secret',
    })
    expect(await session.token()).toBe('app-token')
    expect(await session.token()).toBe('app-token')
    expect(tokenCalls).toBe(1)
  })
})
