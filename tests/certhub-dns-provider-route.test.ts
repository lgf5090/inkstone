// @vitest-environment node
/**
 * What the provider PATCH does with the secret field, and what the token looks like once stored.
 *
 * The form's "leave empty to keep / fill to replace" promise is a route-level branch: it is not
 * visible in the schema alone. These cases read the ciphertext back out of the vault after the
 * request, so a change that silently clears or keeps the old token fails here.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { DEVELOPMENT_CERTHUB_SCHEMA_STATEMENTS } from '../src/worker/development/certhub/schema'
import { developmentCerthubRoutes } from '../src/worker/routes/development-certhub'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { decryptCerthubDnsCredential, encryptCerthubDnsCredential } from '../src/worker/lib/crypto'
import { dnsProviderSchema } from '../src/shared/development/certhub/validation'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '01m6x7pbeg5pc4vfgqt1vtzd00'
const PROVIDER = '01m6x5h138kwsw8ssz29qhqv5r'

const vaultStorage = new Map<string, unknown>()
let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function storedCiphertext(id: string): string {
  const row = sqlite.prepare('SELECT credential_ciphertext AS c FROM development_certhub_dns_providers WHERE id = ?').get(id) as { c?: string } | undefined
  return row?.c ?? ''
}

async function storedToken(id: string): Promise<string> {
  const credential = await decryptCerthubDnsCredential(env, id, storedCiphertext(id))
  return credential?.token ?? ''
}

beforeEach(async () => {
  vaultStorage.clear()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_CERTHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) =>
      new CredentialVault(vaultState()).fetch(request),
    ),
  })
  const ciphertext = await encryptCerthubDnsCredential(env, PROVIDER, { token: 'old-token' })
  sqlite.prepare(`INSERT INTO development_certhub_dns_providers (
    user_id, id, kind, label, zone_id, zone_name, account_email, credential_ciphertext,
    status, last_checked_at, last_error_code, last_error_message, created_at, updated_at
  ) VALUES (?,?,'cloudflare','local-zone','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','example.com','demo@example.com',?,
    'active',NULL,NULL,NULL,1,1)`).run(USER, PROVIDER, ciphertext)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('sessionId', 'session-1')
    c.set('user', {
      id: USER, username: 'localdemo', login: 'localdemo@example.com', name: 'Local Demo',
      avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '',
    })
    await next()
  })
  app.route('/api/development/certhub', developmentCerthubRoutes)
})

afterEach(() => {
  sqlite.close()
})

function patch(body: Record<string, unknown>) {
  return app.request(`/api/development/certhub/dns-providers/${PROVIDER}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

describe('provider secret patch', () => {
  it('keeps the stored token when the secret is absent, empty or whitespace', async () => {
    expect((await patch({ label: 'renamed' })).status).toBe(200)
    expect(await storedToken(PROVIDER)).toBe('old-token')
    expect((await patch({ secret: '' })).status).toBe(200)
    expect(await storedToken(PROVIDER)).toBe('old-token')
    expect((await patch({ secret: '  \n\t ' })).status).toBe(200)
    expect(await storedToken(PROVIDER)).toBe('old-token')
  })

  it('replaces the stored token with the trimmed, Bearer-stripped value', async () => {
    expect((await patch({ secret: '  Bearer new-token \n' })).status).toBe(200)
    expect(await storedToken(PROVIDER)).toBe('new-token')
  })

  it('stores a normalized token on create', async () => {
    const response = await app.request('/api/development/certhub/dns-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'cloudflare', label: 'created', zoneId: 'b'.repeat(32), zoneName: 'created.example.com',
        secret: '  Bearer created-token \n',
      }),
    }, env)
    expect(response.status).toBe(200)
    const row = sqlite.prepare("SELECT id FROM development_certhub_dns_providers WHERE label = 'created'").get() as { id: string }
    expect(await storedToken(row.id)).toBe('created-token')
  })
})

describe('provider secret schema', () => {
  it('trims the ends but leaves the Bearer prefix for the route to normalize', () => {
    expect(dnsProviderSchema.partial().parse({ secret: ' \n ' }).secret).toBe('')
    expect(dnsProviderSchema.partial().parse({ secret: ' Bearer tok \n' }).secret).toBe('Bearer tok')
  })
})
