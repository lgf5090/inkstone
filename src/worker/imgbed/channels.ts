import { IMGBED_CHANNEL_TYPES, type ImgbedChannel, type ImgbedChannelType } from '@shared/imgbed/model'
import { decryptImgbedSecret, encryptImgbedSecret, type ImgbedSecretRecord } from '../lib/crypto'
import type { Env } from '../env'
import { newId } from '../lib/id'

interface ChannelRow {
  id: string
  type: string
  name: string
  config: string
  credentials_ciphertext: string
  credentials_hint: string
  enabled: number
  fixed: number
  quota_enabled: number
  quota_limit_gb: number | null
  quota_threshold: number
  position: number
  created_at: number
  updated_at: number
}

export interface ResolvedChannel extends ImgbedChannel {
  credentials: ImgbedSecretRecord
}

const ENV_CHANNEL_IDS: Record<ImgbedChannelType, string> = {
  telegram: 'env_telegram_0000000000000000',
  cfr2: 'env_cfr2_00000000000000000000',
  s3: 'env_s3_0000000000000000000000',
  discord: 'env_discord_00000000000000000',
  huggingface: 'env_huggingface_00000000000',
  webdav: 'env_webdav_00000000000000000',
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toChannel(row: ChannelRow): ImgbedChannel {
  return {
    id: row.id,
    type: row.type as ImgbedChannelType,
    name: row.name,
    config: parseObject(row.config),
    enabled: row.enabled === 1,
    fixed: row.fixed === 1,
    quota: {
      enabled: row.quota_enabled === 1,
      limitGB: row.quota_limit_gb,
      threshold: row.quota_threshold,
    },
    hasCredentials: row.credentials_ciphertext.length > 0,
  }
}


function envChannel(env: Env, type: ImgbedChannelType): ResolvedChannel | null {
  switch (type) {
    case 'telegram': {
      if (!env.TG_BOT_TOKEN) return null
      return {
        id: ENV_CHANNEL_IDS.telegram, type, name: 'Telegram_env', fixed: true, enabled: true,
        config: { chatId: env.TG_CHAT_ID ?? '', proxyUrl: env.TG_PROXY_URL ?? '' },
        credentials: { botToken: env.TG_BOT_TOKEN },
        quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
    case 'cfr2': {
      if (!env.FILES) return null
      return {
        id: ENV_CHANNEL_IDS.cfr2, type, name: 'R2_env', fixed: true, enabled: true,
        config: { publicUrl: env.R2_PUBLIC_URL ?? '' },
        credentials: {}, quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
    case 's3': {
      if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null
      return {
        id: ENV_CHANNEL_IDS.s3, type, name: 'S3_env', fixed: true, enabled: true,
        config: {
          region: env.S3_REGION ?? 'auto', bucketName: env.S3_BUCKET_NAME ?? '',
          endpoint: env.S3_ENDPOINT ?? '', pathStyle: env.S3_PATH_STYLE === 'true',
          cdnDomain: env.S3_CDN_DOMAIN ?? '', userAgent: env.S3_USER_AGENT ?? '',
        },
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
        quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
    case 'discord': {
      if (!env.DISCORD_BOT_TOKEN) return null
      return {
        id: ENV_CHANNEL_IDS.discord, type, name: 'Discord_env', fixed: true, enabled: true,
        config: {
          channelId: env.DISCORD_CHANNEL_ID ?? '', proxyUrl: env.DISCORD_PROXY_URL ?? '',
          isNitro: env.DISCORD_IS_NITRO === 'true',
        },
        credentials: { botToken: env.DISCORD_BOT_TOKEN },
        quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
    case 'huggingface': {
      if (!env.HF_TOKEN) return null
      return {
        id: ENV_CHANNEL_IDS.huggingface, type, name: 'HuggingFace_env', fixed: true, enabled: true,
        config: { repo: env.HF_REPO ?? '', isPrivate: env.HF_PRIVATE === 'true' },
        credentials: { token: env.HF_TOKEN },
        quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
    case 'webdav': {
      if (!env.WEBDAV_BASE_URL) return null
      return {
        id: ENV_CHANNEL_IDS.webdav, type, name: 'WebDAV_env', fixed: true, enabled: true,
        config: {
          baseUrl: env.WEBDAV_BASE_URL, publicUrl: env.WEBDAV_PUBLIC_URL ?? '',
          headers: safeHeaders(env.WEBDAV_HEADERS), createDirectory: env.WEBDAV_CREATE_DIRECTORY !== 'false',
        },
        credentials: { username: env.WEBDAV_USERNAME ?? '', password: env.WEBDAV_PASSWORD ?? '' },
        quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: true,
      }
    }
  }
}

function safeHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, field]) => /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(key) && typeof field === 'string')
      .slice(0, 16)) as Record<string, string>
  } catch {
    return {}
  }
}

const credentialCache = new Map<string, { value: ImgbedSecretRecord; at: number }>()
const CREDENTIAL_CACHE_MS = 60_000

export async function resolveChannelCredentials(
  env: Env,
  channel: ImgbedChannel,
  ciphertext: string,
): Promise<ImgbedSecretRecord | null> {
  if (channel.fixed) return envChannel(env, channel.type)?.credentials ?? null
  if (!ciphertext) return {}
  const cached = credentialCache.get(ciphertext)
  if (cached && Date.now() - cached.at < CREDENTIAL_CACHE_MS) return cached.value
  const value = await decryptImgbedSecret(env, channel.id, ciphertext)
  if (value) credentialCache.set(ciphertext, { value, at: Date.now() })
  return value
}

export async function listResolvedChannels(
  env: Env,
  db: D1Database,
  includeDisabled = false,
): Promise<ResolvedChannel[]> {
  const { results } = await db.prepare(
    'SELECT * FROM imgbed_channels ORDER BY type, position, created_at',
  ).all<ChannelRow>()
  const out: ResolvedChannel[] = []
  for (const type of IMGBED_CHANNEL_TYPES) {
    const virtual = envChannel(env, type)
    if (virtual) out.push(virtual)
  }
  for (const row of results ?? []) {
    const channel = toChannel(row)
    const credentials = await resolveChannelCredentials(env, channel, row.credentials_ciphertext) ?? {}
    out.push({ ...channel, credentials })
  }
  return includeDisabled ? out : out.filter((channel) => channel.enabled)
}

export async function getResolvedChannel(
  env: Env,
  db: D1Database,
  type: ImgbedChannelType,
  name: string,
): Promise<ResolvedChannel | null> {
  const virtual = envChannel(env, type)
  if (virtual && virtual.name === name) return virtual
  const row = await db.prepare('SELECT * FROM imgbed_channels WHERE type = ?1 AND name = ?2 LIMIT 1')
    .bind(type, name).first<ChannelRow>()
  if (!row) return virtual && !name ? virtual : null
  const channel = toChannel(row)
  const credentials = await resolveChannelCredentials(env, channel, row.credentials_ciphertext) ?? {}
  return { ...channel, credentials }
}

export async function getChannelRow(db: D1Database, id: string): Promise<ChannelRow | null> {
  return await db.prepare('SELECT * FROM imgbed_channels WHERE id = ?1').bind(id).first<ChannelRow>()
}

export async function resolveChannelByName(
  env: Env,
  db: D1Database,
  type: ImgbedChannelType,
  name?: string | null,
): Promise<ResolvedChannel | null> {
  const channels = (await listResolvedChannels(env, db)).filter((channel) => channel.type === type)
  if (!channels.length) return null
  if (name) return channels.find((channel) => channel.name === name) ?? null
  return channels[0] ?? null
}

export async function saveChannel(
  env: Env,
  db: D1Database,
  input: {
    id?: string
    type: ImgbedChannelType
    name: string
    config: Record<string, unknown>
    credentials?: ImgbedSecretRecord
    enabled?: boolean
    quota?: { enabled: boolean; limitGB: number | null; threshold: number }
  },
): Promise<ImgbedChannel> {
  const now = Date.now()
  const id = input.id ?? newId()
  const existing = input.id ? await getChannelRow(db, id) : null
  if (existing?.fixed === 1) throw new Error('fixed_channel')
  const ciphertext = input.credentials && Object.keys(input.credentials).length
    ? await encryptImgbedSecret(env, id, input.credentials)
    : existing?.credentials_ciphertext ?? ''
  const hint = input.credentials && Object.keys(input.credentials).length
    ? JSON.stringify(Object.fromEntries(Object.keys(input.credentials).map((key) => [key, true])))
    : existing?.credentials_hint ?? '{}'
  const quota = input.quota ?? {
    enabled: existing?.quota_enabled === 1,
    limitGB: existing?.quota_limit_gb ?? null,
    threshold: existing?.quota_threshold ?? 95,
  }
  await db.prepare(
    `INSERT INTO imgbed_channels
       (id, type, name, config, credentials_ciphertext, credentials_hint, enabled, fixed,
        quota_enabled, quota_limit_gb, quota_threshold, position, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?11,?12,?13)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, config=excluded.config,
       credentials_ciphertext=excluded.credentials_ciphertext, credentials_hint=excluded.credentials_hint,
       enabled=excluded.enabled, quota_enabled=excluded.quota_enabled,
       quota_limit_gb=excluded.quota_limit_gb, quota_threshold=excluded.quota_threshold,
       updated_at=excluded.updated_at`,
  ).bind(
    id, input.type, input.name.slice(0, 128), JSON.stringify(input.config),
    ciphertext, hint, input.enabled === false ? 0 : 1, quota.enabled ? 1 : 0, quota.limitGB,
    quota.threshold, existing?.position ?? 0, existing?.created_at ?? now, now,
  ).run()
  const row = await getChannelRow(db, id)
  if (!row) throw new Error('channel_not_saved')
  return toChannel(row)
}

export async function deleteChannel(db: D1Database, id: string): Promise<boolean> {
  const row = await getChannelRow(db, id)
  if (!row || row.fixed === 1) return false
  await db.prepare('DELETE FROM imgbed_channels WHERE id = ?1').bind(id).run()
  return true
}

import { getChannelUsage } from './store'

function canonicalChannelType(type: string): string {
  return type === 'cfr2' ? 'CloudflareR2' : type === 'telegram' ? 'TelegramNew' : type === 's3' ? 'S3'
    : type === 'discord' ? 'Discord' : type === 'huggingface' ? 'HuggingFace' : 'WebDAV'
}

export async function availableChannelsForUpload(env: Env, db: D1Database): Promise<ResolvedChannel[]> {
  const channels = await listResolvedChannels(env, db)
  const usage = await getChannelUsage(db)
  return channels.filter((channel) => {
    if (!channel.quota.enabled || !channel.quota.limitGB) return true
    const used = usage.find((row) => row.channelName === channel.name || row.channel === canonicalChannelType(channel.type))
    const usedGB = (used?.usedMB ?? 0) / 1024
    return (usedGB / channel.quota.limitGB) * 100 < channel.quota.threshold
  })
}
