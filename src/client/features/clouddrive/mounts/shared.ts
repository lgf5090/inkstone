import { t } from '../../../lib/i18n'

export interface Storage {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  status: string
  isDefault: boolean
  hasCredentials: boolean
  defaultPath: string
  lastTestAt: number | null
  lastTestStatus: string | null
  createdAt: number
}

export interface Mount {
  id: string
  storageId: string
  name: string
  mountPath: string
  readOnly: boolean
  cacheTtl: number
  sortOrder: number
  enabled: boolean
  remark: string
  createdAt: number
}

const TYPE_KEYS = {
  s3: 'clouddrive.storage.type_s3',
  webdav: 'clouddrive.storage.type_webdav',
  github: 'clouddrive.storage.type_github',
  huggingface: 'clouddrive.storage.type_huggingface',
  discord: 'clouddrive.storage.type_discord',
  telegram: 'clouddrive.storage.type_telegram',
  onedrive: 'clouddrive.storage.type_onedrive',
  googledrive: 'clouddrive.storage.type_googledrive',
} as const

export type StorageType = keyof typeof TYPE_KEYS
export const STORAGE_TYPE_VALUES = Object.keys(TYPE_KEYS) as StorageType[]

export function storageTypeLabel(type: string): string {
  const key = TYPE_KEYS[type as StorageType]
  return key ? t(key) : type.toUpperCase()
}

const PROVIDER_KEYS = {
  r2: 'clouddrive.admin.storage.provider_r2',
  b2: 'clouddrive.admin.storage.provider_b2',
  aws: 'clouddrive.admin.storage.provider_aws',
  oss: 'clouddrive.admin.storage.provider_oss',
  other: 'clouddrive.admin.storage.provider_other',
} as const

export function storageProviderLabel(provider: string): string {
  const key = PROVIDER_KEYS[provider as keyof typeof PROVIDER_KEYS]
  return key ? t(key) : provider
}

export function storageEndpoint(storage: Storage): string {
  const config = storage.config
  return String(config.endpoint ?? config.baseUrl ?? config.repo ?? config.chatId ?? config.channelId ?? config.driveId ?? config.folderId ?? '')
}

export const PAGE_SIZE_OPTIONS = [4, 8, 12, 24] as const

export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize)
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

export function pageLabel(from: number, to: number, total: number): string {
  return t('clouddrive.admin.page_info', { from: String(from), to: String(to), total: String(total) })
}
