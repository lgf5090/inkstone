// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../src/shared/assistant'
import { createEmailAccount } from '../../src/worker/email/account-store'
import {
  batchEmailAgent,
  createEmailFolderAgent,
  createEmailTagAgent,
  deleteEmailAgent,
  inspectEmailAgent,
  manageEmailContactAgent,
  manageEmailRuleAgent,
  manageEmailSearchAgent,
  manageEmailSignatureAgent,
  manageEmailTemplateAgent,
  prepareDeleteEmailAgent,
  prepareScheduleEmailAgent,
  prepareSendEmailAgent,
  scheduleEmailAgent,
  sendEmailAgent,
  tagEmailAgent,
  updateEmailDraftAgent,
  updateEmailFolderAgent,
  updateEmailMessageAgent,
  updateEmailSettingsAgent,
} from '../../src/worker/email/agent'
import { listScheduledSends } from '../../src/worker/email/scheduled-send'
import { newId } from '../../src/worker/lib/id'
import { ToolExecutor, type ToolContext } from '../../src/worker/assistant/tools'
import type { AssistantStore } from '../../src/worker/assistant/store'
import { mailboxHarness, seedUser, testDatabase, type MailboxHarness } from '../fixtures/email/harness'

let db: D1Database
let boxes: MailboxHarness
let env: Env
let accountId: string
const owner = 'owner-1'
const member = 'member-1'

function seedMessage(id: string, patch: { folder?: string; threadId?: string | null; subject?: string } = {}): void {
  const created = boxes.store(accountId).createEmail(patch.folder ?? 'inbox', {
    id,
    subject: patch.subject ?? 'Quarterly report',
    sender: 'Grace Hopper <grace@example.com>',
    recipient: 'ada@example.com',
    date: 1_700_000_000_000,
    body: '<p>The numbers are ready.</p>',
    bodySource: 'The numbers are ready.',
    threadId: patch.threadId ?? null,
  })
  expect(created).toBe(true)
}

beforeEach(async () => {
  const database = testDatabase()
  seedUser(database.sqlite, owner)
  seedUser(database.sqlite, member, 'member')
  boxes = mailboxHarness()
  db = database.db
  env = {
    DB: db,
    EMAIL_MAILBOX: boxes.namespace,
    EMAIL: { send: vi.fn(async () => ({ messageId: 'provider-1' })) },
  } as unknown as Env
  const account = await createEmailAccount(db, { userId: owner, address: 'ada@example.com', displayName: 'Ada' })
  accountId = account.id
})

describe('the agent mailbox inspection', () => {
  it('returns the structure and settings the model needs for later calls', async () => {
    const answer = await inspectEmailAgent(env, owner, { accountId, section: 'overview' }) as Record<string, unknown>
    expect(answer.account).toMatchObject({ id: accountId, address: 'ada@example.com' })
    expect(Array.isArray(answer.folders)).toBe(true)
    expect(answer.stats).toMatchObject({ total: 0, trash: 0 })

    const settings = await inspectEmailAgent(env, owner, { accountId, section: 'settings' }) as { settings: Record<string, unknown> }
    expect(settings.settings).toMatchObject({ autoDraft: true, focusedInbox: true, defaultSignatureId: null })
  })

  it('keeps the mailbox away from members', async () => {
    await expect(inspectEmailAgent(env, member, { accountId, section: 'overview' })).rejects.toMatchObject({ status: 403 })
  })
})

describe('the agent organization tools', () => {
  it('creates and updates a folder and refuses a system name', async () => {
    const created = await createEmailFolderAgent(env, owner, { accountId, name: 'Projects', color: '#2563eb' })
    expect(created).toMatchObject({ name: 'Projects', parentId: null })
    const updated = await updateEmailFolderAgent(env, owner, { accountId, folderId: created.id, name: 'Work' })
    expect(updated.name).toBe('Work')
    await expect(createEmailFolderAgent(env, owner, { accountId, name: 'Inbox' })).rejects.toMatchObject({ status: 400 })
  })

  it('creates a tag path, attaches it to a message, and detaches it', async () => {
    const m1 = newId()
    seedMessage(m1)
    await createEmailTagAgent(env, owner, { accountId, name: 'work/urgent' })
    const attached = await tagEmailAgent(env, owner, { accountId, emailId: m1, name: 'work/urgent' })
    expect(attached.attached).toBe(true)
    const detached = await tagEmailAgent(env, owner, { accountId, emailId: m1, tagId: attached.tagId, remove: true })
    expect(detached.attached).toBe(false)
  })
})

describe('the agent message tools', () => {
  it('changes flags, snoozes, sets a follow-up, and clears both', async () => {
    const m1 = newId()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    seedMessage(m1)
    const updated = await updateEmailMessageAgent(env, owner, {
      accountId,
      emailId: m1,
      read: true,
      starred: true,
      important: true,
      followUpAt: future,
    })
    expect(updated).toMatchObject({ read: true, starred: true, important: true })
    expect(updated.followUpAt).toBe(future)

    const snoozed = await updateEmailMessageAgent(env, owner, { accountId, emailId: m1, snoozeUntil: future })
    expect(snoozed.id).toBe(m1)
    expect(snoozed.snoozedUntil).toBe(future)
    const cleared = await updateEmailMessageAgent(env, owner, { accountId, emailId: m1, snoozeUntil: null, followUpAt: null })
    expect(cleared.followUpAt).toBeNull()
  })

  it('moves and batches messages', async () => {
    const m1 = newId()
    seedMessage(m1)
    const m2 = newId()
    seedMessage(m2)
    await updateEmailMessageAgent(env, owner, { accountId, emailId: m1, folder: 'Archive' })
    expect(boxes.store(accountId).getEmail(m1)?.folder_id).toBe('archive')
    const result = await batchEmailAgent(env, owner, { accountId, ids: [m2], action: 'read' })
    expect(result.updated).toBe(1)
    expect(boxes.store(accountId).getEmail(m2)?.read).toBe(1)
  })

  it('edits a saved draft without sending it', async () => {
    const d1 = newId()
    seedMessage(d1, { folder: 'draft' })
    const saved = await updateEmailDraftAgent(env, owner, {
      accountId,
      draftId: d1,
      to: 'grace@example.com',
      subject: 'Changed subject',
      body: 'A new body',
    })
    expect(saved).toMatchObject({ to: 'grace@example.com', subject: 'Changed subject', body: 'A new body' })
    expect(boxes.store(accountId).getEmail(d1)?.folder_id).toBe('draft')
  })
})

describe('the agent send and schedule tools', () => {
  it('sends a saved draft and moves it to Sent', async () => {
    const d1 = newId()
    seedMessage(d1, { folder: 'draft' })
    const prepared = await prepareSendEmailAgent(env, owner, { accountId, mode: 'draft', draftId: d1 })
    expect(prepared.targetLabel).toContain('Quarterly report')
    const result = await sendEmailAgent(env, owner, { accountId, mode: 'draft', draftId: d1, operationId: 'op-send-1' })
    expect(result.status).toBe('sent')
    expect(boxes.store(accountId).getEmail(d1)?.folder_id).toBe('sent')
    expect(env.EMAIL!.send).toHaveBeenCalledTimes(1)
  })

  it('sends a new message through an approval target', async () => {
    const prepared = await prepareSendEmailAgent(env, owner, {
      accountId,
      mode: 'new',
      to: 'grace@example.com',
      subject: 'Hello',
      body: 'A short note.',
    })
    const result = await sendEmailAgent(env, owner, {
      accountId,
      mode: 'new',
      to: 'grace@example.com',
      subject: 'Hello',
      body: 'A short note.',
      operationId: `agent-send:${prepared.targetId}`,
    })
    expect(result.status).toBe('sent')
    expect(result.to).toBe('grace@example.com')
  })

  it('names a scheduled send in local time', async () => {
    const d1 = newId()
    seedMessage(d1, { folder: 'draft' })
    const target = await prepareScheduleEmailAgent(env, owner, {
      accountId,
      action: 'schedule',
      mode: 'draft',
      draftId: d1,
      sendAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, { timezone: 'Asia/Shanghai', locale: 'en-US' })
    expect(target.targetLabel).toContain('ada@example.com - Quarterly report')
    expect(target.targetLabel).not.toContain('T00:00:00.000Z')
  })

  it('schedules a draft and cancels the queued send', async () => {
    const d1 = newId()
    seedMessage(d1, { folder: 'draft' })
    const scheduled = await scheduleEmailAgent(env, owner, {
      accountId,
      action: 'schedule',
      mode: 'draft',
      draftId: d1,
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    }) as { scheduledId: string }
    const jobs = await listScheduledSends(env, owner, accountId)
    expect(jobs.map((job) => job.id)).toContain(scheduled.scheduledId)
    const cancelled = await scheduleEmailAgent(env, owner, { accountId, action: 'cancel', scheduledId: scheduled.scheduledId })
    expect(cancelled.status).toBe('cancelled')
  })
})

describe('the agent configuration tools', () => {
  it('creates a filter from tokens and blocks a sender', async () => {
    const rule = await manageEmailRuleAgent(env, owner, {
      accountId,
      action: 'create',
      name: 'Invoices',
      conditions: ['from:billing@example.com', 'subject:invoice'],
      actions: ['move:Archive', 'star'],
    }) as { filter: { conditions: unknown[]; actions: unknown[] } }
    expect(rule.filter.conditions).toHaveLength(2)
    expect(rule.filter.actions).toHaveLength(2)
    await manageEmailRuleAgent(env, owner, { accountId, action: 'block', address: 'bad@example.com' })
    expect(boxes.store(accountId).isBlockedSender('bad@example.com')).toBe(true)
  })

  it('creates templates, signatures, saved searches, and contacts', async () => {
    const template = await manageEmailTemplateAgent(env, owner, { accountId, action: 'create', name: 'Update', subject: 'Weekly', body: 'Hello' })
    expect(template).toMatchObject({ status: 'created' })
    const signature = await manageEmailSignatureAgent(env, owner, { accountId, action: 'create', name: 'Work', text: 'Regards' })
    expect(signature).toMatchObject({ status: 'created' })
    expect((signature as { signatures: unknown[] }).signatures).toHaveLength(1)
    const search = await manageEmailSearchAgent(env, owner, { accountId, action: 'create', name: 'Bills', query: 'invoice' })
    expect(search).toMatchObject({ status: 'created' })
    const contact = await manageEmailContactAgent(env, owner, { action: 'create', email: 'Grace@example.com', name: 'Grace' })
    expect(contact).toMatchObject({ status: 'created' })
    const group = await manageEmailContactAgent(env, owner, { action: 'group_create', name: 'Team' })
    expect(group).toMatchObject({ status: 'created' })
  })

  it('keeps signatures and vacation when both change at once', async () => {
    await Promise.all([
      manageEmailSignatureAgent(env, owner, { accountId, action: 'create', name: 'AI', text: 'Sent by AI' }),
      updateEmailSettingsAgent(env, owner, { accountId, vacation: { enabled: true, subject: 'Away', body: 'Back soon' } }),
    ])
    const answer = await inspectEmailAgent(env, owner, { accountId, section: 'settings' }) as { settings: { signatures: unknown[]; vacation: { enabled: boolean } } }
    expect(answer.settings.signatures).toHaveLength(1)
    expect(answer.settings.vacation.enabled).toBe(true)
  })

  it('updates settings and vacation without dropping earlier values', async () => {
    await updateEmailSettingsAgent(env, owner, { accountId, displayName: 'Ada L', autoDraft: false })
    const answer = await updateEmailSettingsAgent(env, owner, {
      accountId,
      vacation: { enabled: true, subject: 'Away', body: 'Back soon' },
    }) as { settings: { autoDraft: boolean; vacation: { enabled: boolean; subject: string } } }
    expect(answer.settings.autoDraft).toBe(false)
    expect(answer.settings.vacation).toMatchObject({ enabled: true, subject: 'Away' })
  })
})

describe('the agent deletion tool', () => {
  it('trashes a message after naming the target for approval', async () => {
    const m1 = newId()
    seedMessage(m1)
    const target = await prepareDeleteEmailAgent(env, owner, { accountId, kind: 'message', id: m1 })
    expect(target.targetLabel).toContain('Quarterly report')
    expect(target.targetLabel).toContain('to Trash')
    const result = await deleteEmailAgent(env, owner, { accountId, kind: 'message', id: m1 })
    expect(result.status).toBe('trashed')
    expect(boxes.store(accountId).getEmail(m1)?.deleted_at).not.toBeNull()
  })
})

describe('the agent tools in the executor', () => {
  function context(settings = DEFAULT_ASSISTANT_SETTINGS): ToolContext {
    const pending: Array<Record<string, unknown>> = []
    const store = {
      userId: owner,
      createPendingAction: vi.fn(async (input: Record<string, unknown>) => {
        pending.push(input)
        return { id: 'action-1' }
      }),
    } as unknown as AssistantStore
    return {
      store,
      env,
      ftsEnabled: false,
      origin: 'https://inkstone.test',
      settings,
      timezone: 'Asia/Shanghai',
      dayEnd: Date.now(),
      mode: 'chat',
      conversationId: 'c1',
      memoryHistory: {} as ToolContext['memoryHistory'],
      memoryScope: { projectId: null },
      automations: {} as ToolContext['automations'],
      noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    }
  }

  it('holds a send for approval and keeps the arguments the card showed', async () => {
    const ctx = context()
    const executor = new ToolExecutor(ctx, { maxToolCalls: 8 })
    const result = await executor.execute('email_send', {
      accountId,
      mode: 'new',
      to: 'grace@example.com',
      subject: 'Hello',
      body: 'A short note.',
    }, 'call-send') as Record<string, unknown>
    expect(result.status).toBe('awaiting_reader_approval')
    expect(ctx.store.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'email_send',
      args: expect.objectContaining({ to: 'grace@example.com', subject: 'Hello' }),
    }))
  })

  it('sends when destructive tools are allowed to run automatically', async () => {
    const ctx = context({ ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { ...DEFAULT_ASSISTANT_SETTINGS.toolModes, destructive: 'auto' } })
    const executor = new ToolExecutor(ctx, { maxToolCalls: 8 })
    const answer = await executor.execute('email_send', {
      accountId,
      mode: 'new',
      to: 'grace@example.com',
      subject: 'Hello',
      body: 'A short note.',
    }, 'call-send-auto') as Record<string, unknown>
    expect(answer.status).toBe('sent')
  })
})
