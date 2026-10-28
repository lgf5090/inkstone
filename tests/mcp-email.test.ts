// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { InMemoryTransport, type JSONObject } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { createEmailAccount } from '../src/worker/email/account-store'
import { applyMailboxMigrations } from '../src/worker/email/mailbox-schema'
import { MailboxStore, type EmailData } from '../src/worker/email/mailbox-store'
import { createMcpApiKey } from '../src/worker/mcp/api-keys'
import { createInkstoneMcpServer } from '../src/worker/mcp/server'
import {
  getMcpPreferences,
  grantedMcpScopes,
  MCP_SCOPES,
  MCP_SUPPORTED_SCOPES,
  putMcpPreferences,
} from '../src/worker/mcp/settings'
import { newId } from '../src/worker/lib/id'
import { makeD1 } from './doubles/d1-sqlite'
import { makeSqlExec } from './doubles/do-sqlite'
import { fakeEmailMailboxNamespace } from './doubles/email-mailbox'
import { testBindings } from './doubles/bindings'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const OTHER = '0123456789abcdefghjkmnpqrv'

const EMAIL_READ = [MCP_SCOPES.read, MCP_SCOPES.emailRead]
const EMAIL_WRITE = [MCP_SCOPES.read, MCP_SCOPES.emailWrite]
const EMAIL_SEND = [MCP_SCOPES.read, MCP_SCOPES.emailSend]
const EMAIL_TRASH = [MCP_SCOPES.read, MCP_SCOPES.emailWrite, MCP_SCOPES.emailTrash]

const EMAIL_TOOL_NAMES = [
  'email_list_accounts',
  'email_list',
  'email_get',
  'email_thread',
  'email_search',
  'email_draft_reply',
  'email_create_draft',
  'email_update_draft',
  'email_delete',
  'email_send',
  'email_send_reply',
  'email_mark_read',
  'email_move',
]

let sqlite: DatabaseSync
let env: Env
let store: MailboxStore
let ownerAccountId: string
let memberAccountId: string
let otherAccountId: string
let sent: Record<string, unknown>[]

function seedUser(id: string, role: 'owner' | 'member'): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, '', '', ?, '{}', 1, 1)`,
  ).run(id, `user-${id}`, `user-${id}`, role)
}

function seedMessage(id: string, folder = 'inbox', data: Partial<EmailData> = {}): void {
  expect(store.createEmail(folder, {
    id,
    subject: 'Harbour gate',
    sender: 'Alice <alice@example.com>',
    recipient: 'owner@example.com',
    date: 1_700_000_000_000,
    body: '<p>Hello there</p>',
    bodySource: 'Hello there',
    ...data,
  })).toBe(true)
}

interface RpcMessage {
  id?: number | string
  result?: {
    isError?: boolean
    content?: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    tools?: Record<string, unknown>[]
  }
  error?: { code: number; message: string }
}

async function withServer<T>(
  auth: { userId: string; role: 'owner' | 'member'; scopes: readonly string[] },
  use: (ask: (method: string, params?: JSONObject) => Promise<RpcMessage>) => Promise<T>,
): Promise<T> {
  const server = createInkstoneMcpServer({
    env,
    auth: { userId: auth.userId, role: auth.role, scopes: [...auth.scopes] },
    origin: 'https://mail.test',
    ftsEnabled: false,
    executionCtx: { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  })
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<number, (message: RpcMessage) => void>()
  client.onmessage = (message) => {
    const id = (message as RpcMessage).id
    if (typeof id === 'number') waiting.get(id)?.(message as RpcMessage)
  }
  await server.connect(serverSide)
  await client.start()
  let nextId = 1
  const ask = (method: string, params: JSONObject = {}) => new Promise<RpcMessage>((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    void client.send({ jsonrpc: '2.0', id, method, params })
  })
  await ask('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'inkstone-test', version: '1' },
  })
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return use(ask)
}

async function callTool(
  auth: { userId: string; role: 'owner' | 'member'; scopes: readonly string[] },
  name: string,
  args: JSONObject = {},
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const message = await withServer(auth, async (ask) => ask('tools/call', { name, arguments: args }))
  if (message.error) {
    return { ok: false, body: { error: { code: 'invalid_request', message: message.error.message } } }
  }
  const text = message.result?.content?.[0]?.text ?? '{}'
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { error: { code: 'invalid_request', message: text } }
  }
  return { ok: !(message.result?.isError ?? false), body }
}

async function failureOf(
  auth: { userId: string; role: 'owner' | 'member'; scopes: readonly string[] },
  name: string,
  args: JSONObject = {},
): Promise<{ code: string; message: string; status: number }> {
  const outcome = await callTool(auth, name, args)
  expect(outcome.ok).toBe(false)
  const error = outcome.body.error as { code: string; message: string; status: number } | undefined
  expect(error, `the refusal carries an error body: ${JSON.stringify(outcome.body)}`).toBeDefined()
  return error as { code: string; message: string; status: number }
}

function owner(scopes: readonly string[]): { userId: string; role: 'owner' | 'member'; scopes: readonly string[] } {
  return { userId: OWNER, role: 'owner', scopes }
}

async function switchPreferences(input: { write?: boolean; trash?: boolean; email?: boolean }): Promise<void> {
  await putMcpPreferences(env.DB, OWNER, {
    writeEnabled: input.write ?? false,
    trashEnabled: input.trash ?? false,
    todoReadEnabled: true,
    emailEnabled: input.email ?? false,
    disabledTools: [],
    updatedAt: Date.now(),
  })
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
  sent = []
  const emailBinding = {
    send: async (message: unknown) => {
      sent.push(message as Record<string, unknown>)
      return { messageId: `provider-${sent.length}` }
    },
  } as unknown as NonNullable<Env['EMAIL']>
  env = testBindings(makeD1(sqlite), {
    EMAIL_MAILBOX: fakeEmailMailboxNamespace(store),
    EMAIL: emailBinding,
  })
  seedUser(OWNER, 'owner')
  seedUser(MEMBER, 'member')
  seedUser(OTHER, 'owner')
  ownerAccountId = (await createEmailAccount(env.DB, {
    userId: OWNER,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
  memberAccountId = (await createEmailAccount(env.DB, {
    userId: MEMBER,
    address: 'member@example.com',
    displayName: 'Member',
  })).id
  otherAccountId = (await createEmailAccount(env.DB, {
    userId: OTHER,
    address: 'other@example.com',
    displayName: 'Other',
  })).id
})

describe('email tools answer under email scopes', () => {
  it('refuses a mailbox read to a key that never named email:read', async () => {
    await switchPreferences({ email: true })
    const refused = await failureOf(owner([MCP_SCOPES.read]), 'email_list_accounts')
    expect(refused).toMatchObject({
      code: 'forbidden',
      status: 403,
      message: `OAuth scope required: ${MCP_SCOPES.emailRead}`,
    })
  })

  it('withholds the scope while the account email switch is off', async () => {
    await switchPreferences({ email: false })
    for (const [name, args] of [
      ['email_list_accounts', {}],
      ['email_list', { account_id: ownerAccountId }],
    ] as const) {
      const refused = await failureOf(owner(EMAIL_READ), name, args)
      expect({ name, ...refused }).toMatchObject({
        name,
        code: 'forbidden',
        status: 403,
        message: `OAuth scope required: ${MCP_SCOPES.emailRead}`,
      })
    }
  })

  it('lists and reads mail once the scope and the switch are both on', async () => {
    await switchPreferences({ email: true })
    const messageId = newId()
    seedMessage(messageId)

    const accounts = await callTool(owner(EMAIL_READ), 'email_list_accounts')
    expect(accounts.ok).toBe(true)
    expect((accounts.body as { accounts: { id: string; address: string; displayName: string }[] }).accounts).toEqual([
      { id: ownerAccountId, address: 'owner@example.com', displayName: 'Owner' },
    ])

    const listed = await callTool(owner(EMAIL_READ), 'email_list', { account_id: ownerAccountId })
    expect(listed.ok).toBe(true)
    expect((listed.body as { emails: { id: string }[] }).emails.map((email) => email.id)).toEqual([messageId])

    const read = await callTool(owner(EMAIL_READ), 'email_get', { account_id: ownerAccountId, email_id: messageId })
    expect(read.ok).toBe(true)
    expect(read.body).toMatchObject({ email: { id: messageId, subject: 'Harbour gate' } })
  })

  it('answers another account’s mailbox with a miss rather than a refusal', async () => {
    await switchPreferences({ email: true })
    const refused = await failureOf(owner(EMAIL_READ), 'email_list', { account_id: otherAccountId })
    expect(refused).toMatchObject({ code: 'not_found', status: 404 })
  })

  it('refuses a member even when the grant carries the scopes', async () => {
    await putMcpPreferences(env.DB, MEMBER, {
      writeEnabled: true,
      trashEnabled: true,
      todoReadEnabled: true,
      emailEnabled: true,
      disabledTools: [],
      updatedAt: Date.now(),
    })
    const refused = await failureOf(
      { userId: MEMBER, role: 'member', scopes: EMAIL_READ },
      'email_list',
      { account_id: memberAccountId },
    )
    expect(refused).toMatchObject({ code: 'forbidden', status: 403 })
  })
})

describe('sending needs the reader’s explicit confirmation', () => {
  it('refuses without confirm and stores nothing', async () => {
    await switchPreferences({ email: true, write: true })
    const refused = await failureOf(owner(EMAIL_SEND), 'email_send', {
      operation_id: 'op-send-no-confirm',
      account_id: ownerAccountId,
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'A short note.',
    })
    expect(refused).toMatchObject({ code: 'bad_request', status: 400 })
    expect(refused.message).toMatch(/confirm/)
    expect(sent).toHaveLength(0)
  })

  it('refuses without an operation id, which the schema requires', async () => {
    await switchPreferences({ email: true, write: true })
    const outcome = await callTool(owner(EMAIL_SEND), 'email_send', {
      account_id: ownerAccountId,
      confirm: true,
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'A short note.',
    })
    expect(outcome.ok).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('sends once confirmed and reports what happened', async () => {
    await switchPreferences({ email: true, write: true })
    const outcome = await callTool(owner(EMAIL_SEND), 'email_send', {
      operation_id: 'op-send-confirmed-1',
      account_id: ownerAccountId,
      confirm: true,
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'A short note.',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.body).toMatchObject({
      status: 'sent',
      deliveryStatus: 'sent',
      verified: false,
    })
    expect(typeof outcome.body.messageId).toBe('string')
    expect(sent).toHaveLength(1)
    expect(await store.getEmail(outcome.body.messageId as string)).toMatchObject({
      folder_id: 'sent',
      delivery_status: 'sent',
      recipient: 'alice@example.com',
    })
  })

  it('answers a retry with the first result instead of sending twice', async () => {
    await switchPreferences({ email: true, write: true })
    const args = {
      operation_id: 'op-send-retry-1',
      account_id: ownerAccountId,
      confirm: true,
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'A short note.',
    }
    const first = await callTool(owner(EMAIL_SEND), 'email_send', args)
    const again = await callTool(owner(EMAIL_SEND), 'email_send', args)
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    expect(again.body).toEqual(first.body)
    expect(sent).toHaveLength(1)

    const changed = await callTool(owner(EMAIL_SEND), 'email_send', { ...args, subject: 'Something else' })
    expect(changed.ok).toBe(false)
    expect((changed.body.error as { code: string }).code).toBe('conflict')
    expect(sent).toHaveLength(1)
  })

  it('refuses while the account write switch is off', async () => {
    await switchPreferences({ email: true, write: false })
    const refused = await failureOf(owner(EMAIL_SEND), 'email_send', {
      operation_id: 'op-send-write-off',
      account_id: ownerAccountId,
      confirm: true,
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'A short note.',
    })
    expect(refused).toMatchObject({ code: 'forbidden', status: 403 })
    expect(refused.message).toMatch(/writes are disabled/)
    expect(sent).toHaveLength(0)
  })

  it('threads a reply under the original and addresses its sender', async () => {
    await switchPreferences({ email: true, write: true })
    const originalId = newId()
    seedMessage(originalId, 'inbox', { messageId: 'orig@example.com' })
    const outcome = await callTool(owner(EMAIL_SEND), 'email_send_reply', {
      operation_id: 'op-reply-1',
      account_id: ownerAccountId,
      email_id: originalId,
      confirm: true,
      body: 'Thanks for the note.',
    })
    expect(outcome.ok).toBe(true)
    expect(await store.getEmail(outcome.body.messageId as string)).toMatchObject({
      folder_id: 'sent',
      recipient: 'alice@example.com',
      subject: 'Re: Harbour gate',
      in_reply_to: 'orig@example.com',
      thread_id: originalId,
    })
    expect(sent[0]).toMatchObject({
      to: 'alice@example.com',
      headers: { 'In-Reply-To': '<orig@example.com>' },
    })
  })
})

describe('deleting is reversible unless email:trash says otherwise', () => {
  it('moves a message to the trash by default', async () => {
    await switchPreferences({ email: true, write: true })
    const messageId = newId()
    seedMessage(messageId)
    const outcome = await callTool(owner(EMAIL_WRITE), 'email_delete', {
      account_id: ownerAccountId,
      email_id: messageId,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.body).toMatchObject({ status: 'trashed', permanent: false })
    const row = sqlite.prepare('SELECT folder_id, deleted_at FROM email_messages WHERE id = ?1')
      .get(messageId) as { folder_id: string; deleted_at: number | null }
    expect(row).toMatchObject({ folder_id: 'trash' })
    expect(row.deleted_at).not.toBeNull()
  })

  it('refuses permanent deletion without the trash scope', async () => {
    await switchPreferences({ email: true, write: true, trash: true })
    const messageId = newId()
    seedMessage(messageId)
    const refused = await failureOf(owner(EMAIL_WRITE), 'email_delete', {
      account_id: ownerAccountId,
      email_id: messageId,
      permanent: true,
    })
    expect(refused).toMatchObject({
      code: 'forbidden',
      status: 403,
      message: `OAuth scope required: ${MCP_SCOPES.emailTrash}`,
    })
    expect(await store.getEmail(messageId)).not.toBeNull()
  })

  it('removes the row for good once the trash scope and switch are on', async () => {
    await switchPreferences({ email: true, write: true, trash: true })
    const messageId = newId()
    seedMessage(messageId)
    const outcome = await callTool(owner(EMAIL_TRASH), 'email_delete', {
      account_id: ownerAccountId,
      email_id: messageId,
      permanent: true,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.body).toMatchObject({ status: 'deleted', permanent: true })
    expect(await store.getEmail(messageId)).toBeNull()
  })
})

describe('drafts never send', () => {
  it('saves a new draft and leaves the outbox untouched', async () => {
    await switchPreferences({ email: true, write: true })
    const outcome = await callTool(owner(EMAIL_WRITE), 'email_create_draft', {
      account_id: ownerAccountId,
      to: 'alice@example.com',
      subject: 'Draft only',
      body: 'For your review.',
    })
    expect(outcome.ok).toBe(true)
    const draft = (outcome.body as { draft: { draftId: string } }).draft
    expect(await store.getEmail(draft.draftId)).toMatchObject({ folder_id: 'draft' })
    expect(sent).toHaveLength(0)
  })

  it('updates the body of a saved draft', async () => {
    await switchPreferences({ email: true, write: true })
    const created = await callTool(owner(EMAIL_WRITE), 'email_create_draft', {
      account_id: ownerAccountId,
      to: 'alice@example.com',
      subject: 'Draft only',
      body: 'For your review.',
    })
    const draftId = (created.body as { draft: { draftId: string } }).draft.draftId
    const updated = await callTool(owner(EMAIL_WRITE), 'email_update_draft', {
      account_id: ownerAccountId,
      draft_id: draftId,
      body: 'A better sentence.',
    })
    expect(updated.ok).toBe(true)
    expect(await store.getEmail(draftId)).toMatchObject({
      folder_id: 'draft',
      body_source: 'A better sentence.',
    })
  })
})

describe('the scope catalogue hides email while the switch is off', () => {
  const open = {
    writeEnabled: true,
    trashEnabled: true,
    todoReadEnabled: true,
    emailEnabled: false,
    disabledTools: [],
    updatedAt: 0,
  }

  it('grants no email scope to an account that never enabled email', () => {
    const scopes = grantedMcpScopes(MCP_SUPPORTED_SCOPES, open)
    expect(scopes.some((scope) => scope.startsWith('email:'))).toBe(false)
    expect(scopes).toEqual([
      MCP_SCOPES.read,
      MCP_SCOPES.write,
      MCP_SCOPES.trash,
      MCP_SCOPES.todoRead,
      MCP_SCOPES.todoWrite,
      MCP_SCOPES.todoDanger,
      MCP_SCOPES.databaseRead,
      MCP_SCOPES.databaseWrite,
    ])
  })

  it('defaults the email switch to off for an account that never touched it', async () => {
    expect((await getMcpPreferences(env.DB, OWNER)).emailEnabled).toBe(false)
    expect((await callTool(owner(EMAIL_READ), 'email_list_accounts')).ok).toBe(false)
  })

  it('grants the email families once the switch is on, under their own switches', () => {
    expect(grantedMcpScopes(MCP_SUPPORTED_SCOPES, { ...open, emailEnabled: true })).toEqual([
      MCP_SCOPES.read,
      MCP_SCOPES.write,
      MCP_SCOPES.trash,
      MCP_SCOPES.todoRead,
      MCP_SCOPES.todoWrite,
      MCP_SCOPES.todoDanger,
      MCP_SCOPES.databaseRead,
      MCP_SCOPES.databaseWrite,
      MCP_SCOPES.emailRead,
      MCP_SCOPES.emailWrite,
      MCP_SCOPES.emailSend,
      MCP_SCOPES.emailTrash,
    ])
    const readsOnly = grantedMcpScopes(MCP_SUPPORTED_SCOPES, {
      ...open,
      emailEnabled: true,
      writeEnabled: false,
      trashEnabled: false,
    })
    expect(readsOnly.filter((scope) => scope.startsWith('email:'))).toEqual([MCP_SCOPES.emailRead])
  })

  it('mints no email scope while the switch is off, even when the key asks by name', async () => {
    const refused = await createMcpApiKey(env.DB, OWNER, 'mailbot', [
      MCP_SCOPES.emailRead,
      MCP_SCOPES.emailWrite,
      MCP_SCOPES.emailSend,
      MCP_SCOPES.emailTrash,
    ])
    expect(refused.record.scopes).toEqual([MCP_SCOPES.read])

    await switchPreferences({ email: true, write: true, trash: true })
    const minted = await createMcpApiKey(env.DB, OWNER, 'mailbot', [
      MCP_SCOPES.emailRead,
      MCP_SCOPES.emailWrite,
      MCP_SCOPES.emailSend,
      MCP_SCOPES.emailTrash,
    ])
    expect(minted.record.scopes).toEqual([
      MCP_SCOPES.read,
      MCP_SCOPES.emailRead,
      MCP_SCOPES.emailWrite,
      MCP_SCOPES.emailSend,
      MCP_SCOPES.emailTrash,
    ])
  })
})

describe('the server publishes the email tools', () => {
  it('offers all thirteen with the annotations a client builds its behaviour from', async () => {
    const listed = await withServer(owner([MCP_SCOPES.read]), async (ask) => ask('tools/list'))
    const tools = (listed.result?.tools ?? []) as Record<string, unknown>[]
    const byName = new Map(tools.map((tool) => [String(tool.name), tool]))
    for (const name of EMAIL_TOOL_NAMES) {
      expect(byName.get(name), `${name} is published`).toBeDefined()
    }
    expect(byName.get('email_list')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.get('email_create_draft')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.get('email_send')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
    expect(byName.get('email_delete')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })
})
