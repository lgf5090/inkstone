import { Hono, type Context } from 'hono'
import type { EmailAccountSettings, EmailConfig } from '@shared/email/model'
import { EMAIL_ACCOUNT_SETTINGS_MAX_BYTES } from '@shared/email/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { deleteAttachmentObjects } from '../attachments/backend'
import {
  createEmailAccount,
  deleteEmailAccount,
  deleteEmailAttachmentsForAccount,
  getEmailAccount,
  listEmailAccounts,
  listEmailAttachmentKeys,
  toEmailAccount,
  updateEmailAccount,
} from '../email/account-store'
import { emailMailbox } from '../email/mailbox-stub'
import { isValidEmailAddress } from '@shared/email/format'

type Ctx = Context<AppBindings>

const LOCAL_PART_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/i

function allowedDomains(env: AppBindings['Bindings']): string[] {
  const raw = (env.EMAIL_DOMAINS ?? env.MAIL_DOMAIN ?? '').trim()
  if (!raw) return []
  return raw.split(',').map((domain) => domain.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)
}

function configuredAddresses(env: AppBindings['Bindings']): string[] {
  return (env.EMAIL_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
}

function validateLocalPart(localPart: string): string {
  const value = localPart.trim().toLowerCase()
  if (!value || !LOCAL_PART_RE.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw ApiError.badRequest('The mailbox local part is not valid')
  }
  if (value.startsWith('u+')) throw ApiError.badRequest('The u+ prefix is reserved')
  return value
}

function buildAddress(localPart: string, domain: string, env: AppBindings['Bindings']): string {
  const allowed = allowedDomains(env)
  const wantedDomain = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!wantedDomain || !allowed.includes(wantedDomain)) {
    throw ApiError.badRequest('The mailbox domain is not configured')
  }
  const address = `${validateLocalPart(localPart)}@${wantedDomain}`
  const allowlist = configuredAddresses(env)
  if (allowlist.length && !allowlist.includes(address)) {
    throw ApiError.forbidden('This address is not in EMAIL_ADDRESSES')
  }
  if (!isValidEmailAddress(address)) throw ApiError.badRequest('The mailbox address is not valid')
  return address
}

function settingsFrom(value: unknown): EmailAccountSettings {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('The mailbox settings are not an object')
  }
  const raw = value as Record<string, unknown>
  const settings: EmailAccountSettings = {}
  if (raw.signature !== undefined) {
    if (!raw.signature || typeof raw.signature !== 'object') throw ApiError.badRequest('The signature is not valid')
    const signature = raw.signature as Record<string, unknown>
    if (typeof signature.enabled !== 'boolean' || typeof signature.text !== 'string') {
      throw ApiError.badRequest('The signature is not valid')
    }
    settings.signature = { enabled: signature.enabled, text: signature.text.slice(0, 4000) }
  }
  if (raw.agentSystemPrompt !== undefined) {
    if (typeof raw.agentSystemPrompt !== 'string') throw ApiError.badRequest('The agent prompt is not valid')
    const prompt = raw.agentSystemPrompt.trim()
    if (prompt) settings.agentSystemPrompt = prompt.slice(0, 8000)
  }
  if (raw.autoDraft !== undefined) {
    if (typeof raw.autoDraft !== 'boolean') throw ApiError.badRequest('The auto-draft setting is not valid')
    settings.autoDraft = raw.autoDraft
  }
  const encoded = JSON.stringify(settings)
  if (encoded.length > EMAIL_ACCOUNT_SETTINGS_MAX_BYTES) throw ApiError.badRequest('The mailbox settings are too large')
  return settings
}

async function requireAccount(c: Ctx, id: string) {
  if (!isValidId(id)) throw ApiError.notFound('Mailbox not found')
  const account = await getEmailAccount(c.env.DB, c.get('userId'), id)
  if (!account) throw ApiError.notFound('Mailbox not found')
  return account
}

export const emailRoutes = new Hono<AppBindings>()

emailRoutes.use('*', requireAuth)
emailRoutes.use('*', requireOwner)

emailRoutes.get('/config', (c) => {
  const config: EmailConfig = {
    domains: allowedDomains(c.env),
    addresses: configuredAddresses(c.env),
    attachmentsAvailable: Boolean(c.env.FILES) && Boolean(c.env.EMAIL_MAILBOX),
    sendingAvailable: Boolean(c.env.EMAIL),
    autoDraftAvailable: Boolean(c.env.EMAIL_MAILBOX),
    canCreate: true,
  }
  return c.json(config)
})

emailRoutes.get('/accounts', async (c) => {
  const rows = await listEmailAccounts(c.env.DB, c.get('userId'))
  return c.json(rows.map(toEmailAccount))
})

emailRoutes.post('/accounts', async (c) => {
  const body = await readJson<{ localPart?: unknown; domain?: unknown; displayName?: unknown; settings?: unknown }>(
    c,
    JSON_BODY_LIMITS.settings,
  )
  if (typeof body.localPart !== 'string' || typeof body.domain !== 'string') {
    throw ApiError.badRequest('A local part and a domain are required')
  }
  const address = buildAddress(body.localPart, body.domain, c.env)
  const existing = await listEmailAccounts(c.env.DB, c.get('userId'))
  if (existing.some((row) => row.address_normalized === address)) {
    throw ApiError.conflict('That mailbox already exists')
  }
  const conflict = await c.env.DB.prepare(
    `SELECT 1 FROM email_accounts WHERE address_normalized = ?1`,
  ).bind(address).first()
  if (conflict) throw ApiError.conflict('That address is already in use')
  const settings = settingsFrom(body.settings)
  const row = await createEmailAccount(c.env.DB, {
    userId: c.get('userId'),
    address,
    displayName: typeof body.displayName === 'string' ? body.displayName : address.split('@')[0]!,
    settings: { ...settings, autoDraft: settings.autoDraft ?? true },
  })
  return c.json(toEmailAccount(row), 201)
})

emailRoutes.post('/accounts/ensure', async (c) => {
  const userId = c.get('userId')
  const wanted = configuredAddresses(c.env)
  if (!wanted.length) return c.json([])
  const existing = await listEmailAccounts(c.env.DB, userId)
  const known = new Set(existing.map((row) => row.address_normalized))
  const created = []
  for (const address of wanted) {
    if (known.has(address)) continue
    const [localPart, domain] = address.split('@')
    if (!localPart || !domain) continue
    try {
      const row = await createEmailAccount(c.env.DB, {
        userId,
        address,
        displayName: localPart,
      })
      created.push(toEmailAccount(row))
      known.add(address)
    } catch (error) {
      console.warn('[inkstone] configured mailbox could not be created:', (error as Error).message)
    }
  }
  return c.json(created, 201)
})

emailRoutes.get('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  return c.json(toEmailAccount(row))
})

emailRoutes.patch('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const body = await readJson<{ displayName?: unknown; settings?: unknown }>(c, JSON_BODY_LIMITS.settings)
  const updated = await updateEmailAccount(c.env.DB, c.get('userId'), row.id, {
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    settings: body.settings === undefined ? undefined : settingsFrom(body.settings),
  })
  if (!updated) throw ApiError.notFound('Mailbox not found')
  return c.json(toEmailAccount(updated))
})

emailRoutes.delete('/accounts/:id', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const keys = await listEmailAttachmentKeys(c.env.DB, c.get('userId'), row.id)
  if (c.env.FILES && keys.length) {
    await deleteAttachmentObjects(c.env, 'r2', keys).catch((error) => {
      console.warn('[inkstone] mailbox attachment cleanup failed:', (error as Error).message)
    })
  }
  await deleteEmailAttachmentsForAccount(c.env.DB, c.get('userId'), row.id)
  try {
    await emailMailbox(c.env, row.id).deleteAll()
  } catch (error) {
    console.warn('[inkstone] mailbox object cleanup failed:', (error as Error).message)
  }
  const removed = await deleteEmailAccount(c.env.DB, c.get('userId'), row.id)
  if (!removed) throw ApiError.notFound('Mailbox not found')
  return c.body(null, 204)
})

emailRoutes.get('/accounts/:id/folders', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const folders = await emailMailbox(c.env, row.id).getFolders()
  return c.json(folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    isDeletable: Boolean(folder.is_deletable),
    unreadCount: Number(folder.unread_count ?? 0),
  })))
})

emailRoutes.get('/accounts/:id/emails/:messageId', async (c) => {
  const row = await requireAccount(c, c.req.param('id') ?? '')
  const message = await emailMailbox(c.env, row.id).getEmail(c.req.param('messageId') ?? '')
  if (!message) throw ApiError.notFound('Email not found')
  return c.json(message)
})

emailRoutes.get('/files/:attachmentId', async (c) => {
  const id = c.req.param('attachmentId') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const row = await c.env.DB.prepare(
    `SELECT object_key, filename, mime, size FROM email_attachments WHERE user_id = ?1 AND id = ?2`,
  ).bind(c.get('userId'), id).first<{ object_key: string; filename: string; mime: string; size: number }>()
  if (!row || !c.env.FILES) throw ApiError.notFound('Attachment not found')
  const object = await c.env.FILES.get(row.object_key)
  if (!object) throw ApiError.notFound('Attachment not found')
  const headers = new Headers()
  headers.set('Content-Type', row.mime)
  headers.set('Content-Length', String(row.size))
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
  headers.set('Cache-Control', 'private, no-store')
  return new Response(object.body, { headers })
})

