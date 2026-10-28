import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { hashPassword } from '../lib/password'
import { encryptImgbedSecret, IMGBED_SETTINGS_SECRET_SCOPE } from '../lib/crypto'
import {
  IMGBED_CHANNEL_TYPES,
  type ImgbedChannelType,
  type ImgbedTokenScope,
} from '@shared/imgbed/model'
import {
  ImgbedSettingsError,
  parseSettingsGroup,
  type ImgbedSecuritySettings,
  type ImgbedSettingsMap,
} from '@shared/imgbed/settings'
import { requireImgbedActor } from './auth'
import {
  getSettingsGroup,
  getSecretRow,
  saveSettingsGroup,
  saveSecretRow,
} from './store'
import {
  deleteChannel,
  getChannelRow,
  listResolvedChannels,
  saveChannel,
  type ResolvedChannel,
} from './channels'
import { createToken, listTokens, revokeToken, tokenScopes, updateToken } from './tokens'
import { testChannel } from './storage'

export const imgbedSettingsRoutes = new Hono<AppBindings>()

function settingsError(error: unknown): never {
  if (error instanceof ImgbedSettingsError) throw ApiError.badRequest(error.message)
  throw error
}

function publicChannel(channel: ResolvedChannel) {
  return {
    id: channel.id, type: channel.type, name: channel.name, config: channel.config,
    enabled: channel.enabled, fixed: channel.fixed, quota: channel.quota,
    hasCredentials: channel.hasCredentials,
  }
}

function channelSecrets(channel: ResolvedChannel): { hasPassword: boolean; hasToken: boolean } {
  return {
    hasPassword: typeof channel.credentials.password === 'string' && channel.credentials.password.length > 0,
    hasToken: typeof channel.credentials.botToken === 'string' || typeof channel.credentials.token === 'string'
      || typeof channel.credentials.secretAccessKey === 'string',
  }
}

imgbedSettingsRoutes.get('/config', async (c) => {
  const actor = await requireImgbedActor(c, 'list')
  const [page, upload] = await Promise.all([
    getSettingsGroup(c.env.DB, 'page'),
    getSettingsGroup(c.env.DB, 'upload'),
  ])
  const channels = (await listResolvedChannels(c.env, c.env.DB, false))
    .map((channel) => ({ type: channel.type, name: channel.name, id: channel.id, fixed: channel.fixed }))
  return c.json({
    page,
    upload: { maxFileSizeMB: upload.maxFileSizeMB, chunkThresholdMB: upload.chunkThresholdMB, partSizeMB: upload.partSizeMB, loadBalance: upload.loadBalance },
    channels,
    user: { id: actor!.userId, role: actor!.role },
  })
})

imgbedSettingsRoutes.get('/channels', async (c) => {
  const actor = await requireImgbedActor(c, 'list')
  const includeDisabled = new URL(c.req.url).searchParams.get('includeDisabled') === 'true' && actor!.role === 'owner'
  const channels = await listResolvedChannels(c.env, c.env.DB, includeDisabled)
  return c.json({ channels: channels.map((channel) => ({ ...publicChannel(channel), ...channelSecrets(channel) })) })
})

imgbedSettingsRoutes.post('/channels', async (c) => {
  await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as {
    type?: string; name?: string; config?: Record<string, unknown>; credentials?: Record<string, string | boolean>;
    enabled?: boolean; quota?: { enabled?: boolean; limitGB?: number | null; threshold?: number }
  } | null
  try {
    if (!body || !(IMGBED_CHANNEL_TYPES as readonly string[]).includes(body.type ?? '')) throw new ImgbedSettingsError('Unknown channel type')
    const type = body.type as ImgbedChannelType
    const name = String(body.name ?? '').trim()
    if (!name || name.length > 128) throw new ImgbedSettingsError('A channel name is required')
    validateChannelConfig(type, record(body.config), record(body.credentials))
    const channel = await saveChannel(c.env, c.env.DB, {
      type, name, config: record(body.config), credentials: record(body.credentials),
      enabled: body.enabled !== false,
      quota: { enabled: body.quota?.enabled === true, limitGB: body.quota?.limitGB ?? null, threshold: body.quota?.threshold ?? 95 },
    })
    return c.json({ channel: publicChannel({ ...channel, credentials: {} } as ResolvedChannel) }, 201)
  } catch (error) { return settingsError(error) }
})

imgbedSettingsRoutes.put('/channels/:id', async (c) => {
  await requireImgbedActor(c, 'manage')
  const id = c.req.param('id')
  const existing = await getChannelRow(c.env.DB, id)
  if (!existing) throw ApiError.notFound('Channel not found')
  if (existing.fixed === 1) throw ApiError.badRequest('Environment channels are configured by deployment variables')
  const body = await c.req.json().catch(() => null) as {
    name?: string; config?: Record<string, unknown>; credentials?: Record<string, string | boolean>;
    enabled?: boolean; quota?: { enabled?: boolean; limitGB?: number | null; threshold?: number }
  } | null
  try {
    const type = existing.type as ImgbedChannelType
    validateChannelConfig(type, record(body?.config), record(body?.credentials), true)
    const channel = await saveChannel(c.env, c.env.DB, {
      id, type, name: String(body?.name ?? existing.name).trim(), config: record(body?.config),
      credentials: Object.keys(record(body?.credentials)).length ? record(body?.credentials) : undefined,
      enabled: body?.enabled ?? existing.enabled === 1,
      quota: { enabled: body?.quota?.enabled ?? existing.quota_enabled === 1, limitGB: body?.quota?.limitGB ?? existing.quota_limit_gb, threshold: body?.quota?.threshold ?? existing.quota_threshold },
    })
    return c.json({ channel: publicChannel({ ...channel, credentials: {} } as ResolvedChannel) })
  } catch (error) { return settingsError(error) }
})

imgbedSettingsRoutes.delete('/channels/:id', async (c) => {
  await requireImgbedActor(c, 'manage')
  if (!(await deleteChannel(c.env.DB, c.req.param('id')))) throw ApiError.badRequest('Channel cannot be deleted')
  return c.json({ ok: true })
})

imgbedSettingsRoutes.post('/channels/:id/test', async (c) => {
  await requireImgbedActor(c, 'manage')
  const channel = (await listResolvedChannels(c.env, c.env.DB, true)).find((item) => item.id === c.req.param('id'))
  if (!channel) throw ApiError.notFound('Channel not found')
  return c.json(await testChannel(c.env, channel))
})

imgbedSettingsRoutes.get('/settings/:group', async (c) => {
  const group = c.req.param('group') as keyof ImgbedSettingsMap
  if (!['page', 'upload', 'security', 'others', 'ai'].includes(group)) throw ApiError.notFound('Unknown settings group')
  await requireImgbedActor(c, 'manage')
  const value = await getSettingsGroup(c.env.DB, group)
  const secrets = await getSecretRow<{ moderateApiKeyCiphertext?: string }>(c.env.DB, 'secrets') ?? {}
  if (group === 'security') {
    const security = value as ImgbedSecuritySettings
    return c.json({
      value: { ...security, moderate: { ...security.moderate, moderateContentApiKey: '' } },
      hasModerateKey: Boolean(secrets.moderateApiKeyCiphertext),
    })
  }
  if (group === 'others') {
    const others = value as ImgbedSettingsMap['others']
    return c.json({ value: { ...others, webDAV: { ...others.webDAV, passwordHash: '', hasPassword: Boolean(others.webDAV.passwordHash) } } })
  }
  return c.json({ value })
})

imgbedSettingsRoutes.put('/settings/:group', async (c) => {
  const group = c.req.param('group') as keyof ImgbedSettingsMap
  if (!['page', 'upload', 'security', 'others', 'ai'].includes(group)) throw ApiError.notFound('Unknown settings group')
  await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) throw ApiError.badRequest('Invalid settings body')
  const previous = await getSettingsGroup(c.env.DB, group)
  try {
    let parsed = parseSettingsGroup(group, body, previous)
    if (group === 'security') {
      const input = record(body.moderate)
      const security = parsed as ImgbedSecuritySettings
      const key = typeof input.moderateContentApiKey === 'string' ? input.moderateContentApiKey.trim() : ''
      const clear = input.clearApiKey === true
      const secrets = await getSecretRow<{ moderateApiKeyCiphertext?: string; moderateApiKeyHint?: string }>(c.env.DB, 'secrets') ?? {}
      if (key) {
        const ciphertext = await encryptImgbedSecret(c.env, IMGBED_SETTINGS_SECRET_SCOPE, { apiKey: key })
        secrets.moderateApiKeyCiphertext = ciphertext
        secrets.moderateApiKeyHint = key.length > 6 ? `${key.slice(0, 2)}******${key.slice(-4)}` : '******'
      } else if (clear) {
        delete secrets.moderateApiKeyCiphertext
        delete secrets.moderateApiKeyHint
      }
      await saveSecretRow(c.env.DB, 'secrets', secrets)
      security.moderate.moderateContentApiKey = ''
      parsed = security as ImgbedSettingsMap[typeof group]
    }
    if (group === 'others') {
      const inputWebdav = record(body.webDAV)
      const others = parsed as ImgbedSettingsMap['others']
      const previousOthers = previous as ImgbedSettingsMap['others']
      const password = typeof inputWebdav.password === 'string' ? inputWebdav.password.trim() : ''
      if (inputWebdav.clearPassword === true) others.webDAV.passwordHash = ''
      else if (password) {
        if (password.length < 8 || password.length > 128) throw new ImgbedSettingsError('WebDAV password must be 8-128 characters')
        others.webDAV.passwordHash = await hashPassword(password)
      } else others.webDAV.passwordHash = previousOthers.webDAV.passwordHash
      parsed = others as ImgbedSettingsMap[typeof group]
    }
    await saveSettingsGroup(c.env.DB, group, parsed)
    if (group === 'security') return c.json({ value: { ...(parsed as ImgbedSecuritySettings), moderate: { ...(parsed as ImgbedSecuritySettings).moderate, moderateContentApiKey: '' } } })
    if (group === 'others') return c.json({ value: { ...(parsed as ImgbedSettingsMap['others']), webDAV: { ...(parsed as ImgbedSettingsMap['others']).webDAV, passwordHash: '' } } })
    return c.json({ value: parsed })
  } catch (error) { return settingsError(error) }
})

imgbedSettingsRoutes.get('/tokens', async (c) => {
  await requireImgbedActor(c, 'manage')
  return c.json({ tokens: await listTokens(c.env.DB) })
})

imgbedSettingsRoutes.post('/tokens', async (c) => {
  const actor = await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as {
    name?: string; scopes?: string[]; expiresAt?: number | null; autoDelete?: boolean
  } | null
  const name = String(body?.name ?? '').trim()
  const scopes = tokenScopes(body?.scopes)
  if (!name || !scopes.length) throw ApiError.badRequest('A name and at least one scope are required')
  const expiresAt = typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt) ? body.expiresAt : null
  const result = await createToken(c.env.DB, {
    name, scopes: scopes as ImgbedTokenScope[], expiresAt, autoDelete: body?.autoDelete === true,
    createdBy: actor!.userId,
  })
  return c.json(result, 201)
})

imgbedSettingsRoutes.put('/tokens/:id', async (c) => {
  await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as { scopes?: string[]; expiresAt?: number | null; autoDelete?: boolean } | null
  const ok = await updateToken(c.env.DB, c.req.param('id'), {
    scopes: body?.scopes ? tokenScopes(body.scopes) : undefined,
    expiresAt: body?.expiresAt,
    autoDelete: body?.autoDelete,
  })
  if (!ok) throw ApiError.notFound('Token not found')
  return c.json({ ok: true })
})

imgbedSettingsRoutes.delete('/tokens/:id', async (c) => {
  await requireImgbedActor(c, 'manage')
  if (!(await revokeToken(c.env.DB, c.req.param('id')))) throw ApiError.notFound('Token not found')
  return c.json({ ok: true })
})

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function validateChannelConfig(type: ImgbedChannelType, config: Record<string, unknown>, credentials: Record<string, string | boolean>, partial = false): void {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const need = (value: unknown, label: string) => { if (!partial && !text(value)) throw new ImgbedSettingsError(`${label} is required`) }
  if (type === 'telegram') { need(credentials.botToken, 'Bot token'); need(config.chatId, 'Chat id') }
  if (type === 's3') {
    need(credentials.accessKeyId, 'Access key id'); need(credentials.secretAccessKey, 'Secret access key')
    need(config.bucketName, 'Bucket name')
  }
  if (type === 'discord') { need(credentials.botToken, 'Bot token'); need(config.channelId, 'Channel id') }
  if (type === 'huggingface') { need(credentials.token, 'Token'); need(config.repo, 'Repo') }
  if (type === 'webdav') { need(config.baseUrl, 'Base URL') }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') throw new ImgbedSettingsError(`Invalid channel field ${key}`)
  }
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') throw new ImgbedSettingsError(`Invalid credential field ${key}`)
    if (typeof value === 'string' && value.length > 4096) throw new ImgbedSettingsError(`Credential ${key} is too long`)
  }
}
