// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { fromBase64Url, toBase64, utf8 } from '../src/worker/lib/encoding'
import {
  createNoteWebhook,
  deliverNoteWebhook,
  regenerateNoteWebhookSecret,
} from '../src/worker/notes/webhooks'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const NOTE = 'a'.repeat(26)
const URL = 'https://hooks.example/receiver'
const vaultStorage = new Map<string, unknown>()
const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()

let sqlite: DatabaseSync
let env: Env

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

function insertNote(): void {
  sqlite.prepare(`INSERT INTO notes
    (id, user_id, title, content, excerpt, rev, word_count, char_count, position, content_hash, created_at, updated_at)
    VALUES (?, ?, 'Private title', 'secret body', '', 1, 1, 1, 0, '', 1, 1)`).run(NOTE, USER)
}

function deliveries(): Array<{ event: string; payload: string; status: string }> {
  return sqlite.prepare('SELECT event, payload, status FROM note_webhook_deliveries ORDER BY rowid').all() as unknown as Array<{
    event: string
    payload: string
    status: string
  }>
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  vaultStorage.clear()
  env = testBindings(makeD1(sqlite), {
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('note webhooks', () => {
  it('queues created, updated and deleted metadata in the same transaction without note bodies', async () => {
    const { signingSecret } = await createNoteWebhook(env, USER, { title: 'Receiver', url: URL })
    expect(signingSecret).toMatch(/^whsec_/)
    insertNote()
    sqlite.prepare('UPDATE notes SET rev = rev + 1, updated_at = 2 WHERE id = ?').run(NOTE)
    sqlite.prepare('UPDATE notes SET deleted_at = 3, rev = rev + 1 WHERE id = ?').run(NOTE)

    const rows = deliveries()
    expect(rows.map((row) => row.event)).toEqual(['note.created', 'note.updated', 'note.deleted'])
    for (const row of rows) {
      expect(row.payload).not.toContain('secret body')
      expect(JSON.parse(row.payload)).toMatchObject({ id: NOTE, note: { id: NOTE, title: 'Private title' } })
    }
    const stored = sqlite.prepare('SELECT secret_ciphertext FROM note_webhooks').get() as { secret_ciphertext: string }
    expect(stored.secret_ciphertext).not.toBe(signingSecret)
  })

  it('does not enqueue events for disabled webhooks or another account', async () => {
    await createNoteWebhook(env, USER, { title: 'Disabled', url: URL, enabled: false })
    await createNoteWebhook(env, 'user-b', { title: 'Foreign', url: URL })
    insertNote()
    expect(deliveries()).toEqual([])
  })

  it('delivers a standard HMAC signature and can rotate the encrypted secret', async () => {
    const created = await createNoteWebhook(env, USER, { title: 'Receiver', url: URL })
    insertNote()
    const delivery = sqlite.prepare('SELECT id FROM note_webhook_deliveries').get() as { id: string }
    await deliverNoteWebhook(env, delivery.id, Date.now())
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]!
    const headers = init?.headers as Record<string, string>
    const body = String(init?.body)
    const key = await crypto.subtle.importKey(
      'raw', fromBase64Url(created.signingSecret.slice('whsec_'.length)) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, utf8(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`) as BufferSource)
    expect(headers['webhook-signature']).toBe(`v1,${toBase64(signature)}`)
    expect(deliveries()[0]?.status).toBe('delivered')

    const rotated = await regenerateNoteWebhookSecret(env, USER, created.webhook.id)
    expect(rotated?.signingSecret).not.toBe(created.signingSecret)
  })

  it('rejects private or non-HTTPS targets', async () => {
    await expect(createNoteWebhook(env, USER, { title: 'Bad', url: 'http://example.com/hook' })).rejects.toMatchObject({ status: 400 })
    await expect(createNoteWebhook(env, USER, { title: 'Bad', url: 'https://127.0.0.1/hook' })).rejects.toMatchObject({ status: 400 })
  })
})
