// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { createDriverContext } from '../src/worker/clouddrive/drivers/factory'
import { completeGuangYaPanLogin } from '../src/worker/clouddrive/drivers/guangyapan'
import { encryptCloudDriveCredentials, decryptCloudDriveCredentials } from '../src/worker/lib/crypto'
import { newId } from '../src/worker/lib/id'
import { isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

function makeVault(): DurableObjectNamespace {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let storageId: string

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, { CREDENTIAL_VAULT: makeVault() })
  storageId = newId()
  const ciphertext = await encryptCloudDriveCredentials(env, storageId, {
    accessToken: '',
    refreshToken: 'r1',
    clientId: 'client-1',
    clientSecret: 'secret',
  })
  sqlite.prepare(
    `INSERT INTO CloudDrive_storages (user_id, id, name, type, config, credentials, created_at, updated_at)
     VALUES (?, ?, 'cas', 'onedrive', '{}', ?, 1, 5000)`,
  ).run(USER, storageId, ciphertext)
})

function row() {
  return { id: storageId, user_id: USER, type: 'onedrive', config: '{}', credentials: '', updated_at: 5000 }
}

describe('credential compare-and-swap and refresh lease', () => {
  it('lets only the first concurrent refresh write and makes the loser adopt the winner', async () => {
    const first = await createDriverContext(env, {
      ...row(),
      credentials: String(sqlite.prepare('SELECT credentials FROM CloudDrive_storages WHERE id = ?').get(storageId)!.credentials),
    })
    const second = await createDriverContext(env, {
      ...row(),
      credentials: String(sqlite.prepare('SELECT credentials FROM CloudDrive_storages WHERE id = ?').get(storageId)!.credentials),
    })
    const [a, b] = await Promise.all([
      first.saveCredentials({ accessToken: 'a2', refreshToken: 'r2' }, { expect: { accessToken: '', refreshToken: 'r1' } }),
      second.saveCredentials({ accessToken: 'a3', refreshToken: 'r3' }, { expect: { accessToken: '', refreshToken: 'r1' } }),
    ])
    expect(a.accessToken).toBe(b.accessToken)
    expect(a.refreshToken).toBe(b.refreshToken)
    const encrypted = String(sqlite.prepare('SELECT credentials FROM CloudDrive_storages WHERE id = ?').get(storageId)!.credentials)
    const decrypted = await decryptCloudDriveCredentials(env, storageId, encrypted)
    expect(isCredentialRecord(`clouddrive:${storageId}`, decrypted)).toBe(true)
    expect(['r2', 'r3']).toContain(decrypted!.refreshToken)
    expect(decrypted!.refreshToken).toBe(a.refreshToken)
  })

  it('grants the D1 version lease to one caller at a time', async () => {
    const rowValue = sqlite.prepare('SELECT credentials, updated_at FROM CloudDrive_storages WHERE id = ?').get(storageId)!
    const first = await createDriverContext(env, {
      ...row(),
      credentials: String(rowValue.credentials),
      updated_at: Number(rowValue.updated_at),
    })
    const second = await createDriverContext(env, {
      ...row(),
      credentials: String(rowValue.credentials),
      updated_at: Number(rowValue.updated_at),
    })
    expect(await first.refreshLock!.claim()).toBe(true)
    expect(await second.refreshLock!.claim()).toBe(false)
    await first.refreshLock!.release()
    const latest = sqlite.prepare('SELECT updated_at FROM CloudDrive_storages WHERE id = ?').get(storageId)!
    const third = await createDriverContext(env, {
      ...row(),
      credentials: String(rowValue.credentials),
      updated_at: Number(latest.updated_at),
    })
    expect(await third.refreshLock!.claim()).toBe(true)
  })

  it('decrypts the vault rows the factory passes to a driver', async () => {
    const decrypted = await decryptCloudDriveCredentials(env, storageId, String(
      sqlite.prepare('SELECT credentials FROM CloudDrive_storages WHERE id = ?').get(storageId)!.credentials,
    ))
    expect(isScope(`clouddrive:${storageId}`)).toBe(true)
    expect(isCredentialRecord(`clouddrive:${storageId}`, decrypted)).toBe(true)
    expect(decrypted?.refreshToken).toBe('r1')
  })

  it('writes SMS sign-in tokens back through the encrypted vault', async () => {
    const id = newId()
    const ciphertext = await encryptCloudDriveCredentials(env, id, {
      clientId: 'gyp-client',
      deviceId: '0123456789abcdef0123456789abcdef',
      verificationId: 'verification-1',
    })
    sqlite.prepare(
      `INSERT INTO CloudDrive_storages (user_id, id, name, type, config, credentials, created_at, updated_at)
       VALUES (?, ?, 'gyp', 'guangyapan', ?, ?, 2, 6000)`,
    ).run(USER, id, JSON.stringify({ phoneNumber: '+86 13800000000' }), ciphertext)
    const row = sqlite.prepare('SELECT credentials, updated_at FROM CloudDrive_storages WHERE id = ?').get(id)!
    const ctx = await createDriverContext(env, {
      id,
      user_id: USER,
      type: 'guangyapan',
      config: JSON.stringify({ phoneNumber: '+86 13800000000' }),
      credentials: String(row.credentials),
      updated_at: Number(row.updated_at),
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/auth/verification/verify')) {
        return Response.json({ verification_token: 'verification-token' })
      }
      if (url.endsWith('/v1/auth/signin')) {
        return Response.json({ access_token: 'sms-access', refresh_token: 'sms-refresh', expires_in: 3600 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const tokens = await completeGuangYaPanLogin(ctx, '123456')
    expect(tokens.accessToken).toBe('sms-access')
    const stored = await decryptCloudDriveCredentials(env, id, String(
      sqlite.prepare('SELECT credentials FROM CloudDrive_storages WHERE id = ?').get(id)!.credentials,
    ))
    expect(stored?.accessToken).toBe('sms-access')
    expect(stored?.refreshToken).toBe('sms-refresh')
    expect(stored?.verificationId).toBe('')
    vi.unstubAllGlobals()
  })
})
