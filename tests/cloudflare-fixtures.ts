// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { cloudflareRoutes } from '../src/worker/routes/cloudflare'
import { testBindings, testDurableObjectNamespace, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * A deployment shaped like the real one, for the Cloudflare routes.
 *
 * The vault double is deliberately strict about scope: a ciphertext sealed for one account must not
 * open under another, because that is the property the real Durable Object enforces and the property
 * the route tests are supposed to prove.
 */

interface VaultRecord {
  scope: string
  value: unknown
}

export function seal(scope: string, value: unknown): string {
  return `v1.${Buffer.from(JSON.stringify({ scope, value }), 'utf8').toString('base64url')}`
}

function open(ciphertext: string): VaultRecord | null {
  if (!ciphertext.startsWith('v1.')) return null
  try {
    const parsed = JSON.parse(Buffer.from(ciphertext.slice(3), 'base64url').toString('utf8')) as VaultRecord
    return typeof parsed?.scope === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function makeVaultDouble(): DurableObjectNamespace {
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (!body.scope) return Response.json({ error: 'scope_required' }, { status: 400 })
    if (url.pathname.endsWith('/encrypt')) return Response.json({ ciphertext: seal(body.scope, body.value) })
    const record = open(body.ciphertext ?? '')
    if (!record || record.scope !== body.scope) return Response.json({ error: 'scope_mismatch' }, { status: 422 })
    return Response.json({ value: record.value })
  })
}

export interface CloudflareTestBed {
  env: Env
  db: D1Database
  files: TestR2Bucket
  app: Hono<AppBindings>
  sqlite: DatabaseSync
}

export async function makeCloudflareBed(options: { files?: TestR2Bucket; vault?: boolean } = {}): Promise<CloudflareTestBed> {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite)
  await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
  const files = options.files ?? testR2Bucket()
  const env = testBindings(db, {
    FILES: files,
    ...(options.vault === false ? {} : { CREDENTIAL_VAULT: makeVaultDouble() }),
  })
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.route('/api/cloudflare', cloudflareRoutes)
  return { env, db, files, app, sqlite }
}

/** A Cloudflare API stub: handlers match on path and may inspect method/body. */
export function stubCloudflare(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (url.hostname !== 'api.cloudflare.com') {
      throw new Error(`Unexpected outbound fetch in a Cloudflare route test: ${url.toString()}`)
    }
    return await handler(url, init)
  })
}

export function cfJson(result: unknown): Response {
  return Response.json({ success: true, errors: [], result })
}

export async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

export function accountCredentialPath(id: string): string {
  return `cloudflare/txt/accounts/${id}.txt`
}

/** Insert an account row and the credential file it points at. */
export async function seedAccount(
  bed: CloudflareTestBed,
  userId: string,
  options: {
    id?: string
    name?: string
    authType?: 'token' | 'global_key'
    token?: string
    accountId?: string | null
    features?: string
    active?: boolean
  } = {},
): Promise<{ id: string }> {
  const id = options.id ?? 'a'.repeat(26)
  const authType = options.authType ?? 'token'
  const token = options.token ?? 'test-token'
  await bed.files.put(
    accountCredentialPath(id),
    seal(`cloudflare-account:${id}`, authType === 'token' ? { api_token: token } : { api_key: token }),
    { httpMetadata: { contentType: 'text/plain; charset=utf-8' } },
  )
  await bed.env.DB.prepare(
    `INSERT INTO cloudflare_account
      (id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
       available_features, has_credentials, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
  )
    .bind(
      id,
      userId,
      options.name ?? 'Test account',
      authType,
      authType === 'global_key' ? 'test@example.com' : null,
      options.accountId === undefined ? 'b'.repeat(32) : options.accountId,
      options.active === false ? 0 : 1,
      options.features ?? 'ai,workers,browser_render,dns,storage',
      Date.now(),
      Date.now(),
    )
    .run()
  return { id }
}

/** The account id the mocked session belongs to; every route test uses one reader. */
export const TEST_USER = 'u'.repeat(26)
