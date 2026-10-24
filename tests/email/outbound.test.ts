import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_RECIPIENTS_MAX } from '../../src/shared/email/model'
import { CredentialVault } from '../../src/worker/durable/credential-vault'
import { writeEmailDeployment } from '../../src/worker/email/deployment'
import type { Env } from '../../src/worker/env'
import { buildThreadingHeaders, loadOutgoingAttachments, normalizeRecipients, outgoingMessageId, sendViaBinding, sendViaProvider, validateBody, validateFrom } from '../../src/worker/email/outbound'
import { encryptEmailSecret } from '../../src/worker/lib/crypto'
import { newId } from '../../src/worker/lib/id'
import { makeD1 } from '../doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from '../doubles/bindings'

describe('outbound helpers', () => {
  it('accepts only the mailbox sender', () => {
    expect(validateFrom('me@example.com', 'Me <me@example.com>')).toEqual({ address: 'me@example.com', name: 'Me' })
    expect(() => validateFrom('me@example.com', 'other@example.com')).toThrow('mailbox address')
  })

  it('normalizes and bounds recipients', () => {
    expect(normalizeRecipients('A@X.com, b@y.com; a@x.com', 'to')).toEqual(['a@x.com', 'b@y.com'])
    expect(() => normalizeRecipients('not-an-email', 'to')).toThrow('Invalid recipient')
  })

  it('builds threading headers and a message id', () => {
    expect(buildThreadingHeaders('one', ['zero', 'one'])).toEqual({
      'In-Reply-To': '<one>',
      References: '<zero> <one>',
    })
    expect(outgoingMessageId('m1', 'me@example.com')).toBe('m1@example.com')
  })

  it('rejects an empty body', () => {
    expect(() => validateBody({ to: 'a@x.com', subject: 's', body: '', bodyHtml: '', operationId: 'op' }))
      .toThrow('empty')
  })

  it('stops at the recipient limit', () => {
    const addresses = Array.from({ length: EMAIL_RECIPIENTS_MAX + 1 }, (_, index) => `u${index}@example.com`).join(',')
    expect(() => normalizeRecipients(addresses, 'to')).toThrow('Too many recipients')
  })

  it('says sending is unavailable instead of pretending a send happened', async () => {
    await expect(sendViaBinding({} as Env, {
      to: 'a@example.com',
      from: 'me@example.com',
      subject: 'Hello',
    })).rejects.toMatchObject({ status: 503, code: 'email_send_unavailable' })
  })

  it('sends inline attachments with their content id and regular ones without', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE email_attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email_id TEXT,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      object_key TEXT NOT NULL,
      disposition TEXT,
      content_id TEXT,
      locked INTEGER NOT NULL DEFAULT 0
    )`)
    const db = makeD1(sqlite)
    const bucket = testR2Bucket()
    const userId = newId()
    const messageId = newId()
    const inlineId = newId()
    const fileId = newId()
    await bucket.put('mail/inline.png', new TextEncoder().encode('image-bytes'))
    await bucket.put('mail/notes.txt', new TextEncoder().encode('file-bytes'))
    sqlite.prepare(
      `INSERT INTO email_attachments
         (id, user_id, email_id, filename, mime, object_key, disposition, content_id, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(inlineId, userId, messageId, 'photo.png', 'image/png', 'mail/inline.png', 'inline', 'photo-1@inkstone')
    sqlite.prepare(
      `INSERT INTO email_attachments
         (id, user_id, email_id, filename, mime, object_key, disposition, content_id, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(fileId, userId, messageId, 'notes.txt', 'text/plain', 'mail/notes.txt', 'attachment', null)
    const env = testBindings(db, { FILES: bucket })

    const attachments = await loadOutgoingAttachments(env, userId, messageId, [inlineId, fileId])

    expect(attachments).toEqual([
      {
        content: btoa('image-bytes'),
        filename: 'photo.png',
        type: 'image/png',
        disposition: 'inline',
        contentId: 'photo-1@inkstone',
      },
      {
        content: btoa('file-bytes'),
        filename: 'notes.txt',
        type: 'text/plain',
        disposition: 'attachment',
      },
    ])
  })
})

const vaultStorage = new Map<string, unknown>()

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function deploymentEnv(db: D1Database): Env {
  const env = testBindings(db, {
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  return env
}

function deploymentDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE email_deployment_settings (
    id TEXT PRIMARY KEY,
    domains TEXT NOT NULL,
    provider TEXT NOT NULL,
    resend_from TEXT NOT NULL,
    resend_key_ciphertext TEXT NOT NULL,
    resend_key_hint TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  return makeD1(sqlite)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vaultStorage.clear()
})

describe('outbound provider selection', () => {
  it('sends through Resend with the stored sender, Reply-To and attachments', async () => {
    const db = deploymentDb()
    const env = deploymentEnv(db)
    const userId = newId()
    const ciphertext = await encryptEmailSecret(env, userId, 're_live_abcdef')
    await writeEmailDeployment(db, {
      domains: [],
      provider: 'resend',
      resendFrom: 'Inkstone <mail@example.com>',
      resendKeyCiphertext: ciphertext,
      resendKeyHint: 'cdef',
    })
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'resend-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await sendViaProvider(env, userId, {
      to: 'a@example.com',
      from: { email: 'owner@example.com', name: 'Owner' },
      subject: 'Hi',
      html: '<p>Hi</p>',
      headers: { 'Reply-To': 'support@example.com', 'In-Reply-To': '<one@example.com>' },
      attachments: [{ content: btoa('file'), filename: 'a.txt', type: 'text/plain', disposition: 'attachment' }],
    })

    expect(result).toEqual({ messageId: 'resend-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_live_abcdef')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      from: 'Inkstone <mail@example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
      reply_to: 'support@example.com',
      headers: { 'In-Reply-To': '<one@example.com>' },
    })
    expect(body.attachments).toEqual([
      { filename: 'a.txt', content: btoa('file'), content_type: 'text/plain' },
    ])
  })

  it('refuses to fall back when Resend is selected without a key', async () => {
    const db = deploymentDb()
    const env = deploymentEnv(db)
    await writeEmailDeployment(db, {
      domains: [],
      provider: 'resend',
      resendFrom: 'Inkstone <mail@example.com>',
    })

    await expect(sendViaProvider(env, newId(), {
      to: 'a@example.com',
      from: 'owner@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    })).rejects.toMatchObject({ status: 503, code: 'email_send_unavailable' })
  })

  it('keeps the Cloudflare binding when no provider was chosen', async () => {
    const db = deploymentDb()
    const send = vi.fn(async () => ({ messageId: 'cf-1' }))
    const env = deploymentEnv(db)
    env.EMAIL = { send } as unknown as Env['EMAIL']

    const result = await sendViaProvider(env, newId(), {
      to: 'a@example.com',
      from: 'owner@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    })

    expect(result).toEqual({ messageId: 'cf-1' })
    expect(send).toHaveBeenCalledOnce()
  })
})
