/**
 * The single declaration of every storage driver the CloudDrive can mount.
 *
 * The admin UI and the worker read this table, so a driver cannot appear as an option without a
 * definition and a configuration schema. `implemented` gates the dropdown: the 70 drivers that are
 * still to be ported are listed in the roadmap view with the reason instead of becoming dead options.
 *
 * Field labels and driver names are i18n keys. A driver's `fields` describe where each value lives:
 * `config` is returned to the client, `credentials` is encrypted in the vault and never echoed.
 */
export const CLOUDDRIVE_DRIVER_GROUPS = ['china', 'international', 'object', 'virtual', 'protocol'] as const
export type CloudDriveDriverGroup = (typeof CLOUDDRIVE_DRIVER_GROUPS)[number]

export const CLOUDDRIVE_DRIVER_CAPABILITIES = [
  'read', 'write', 'mkdir', 'rename', 'move', 'copy', 'delete', 'directLink', 'range', 'share',
] as const
export type CloudDriveDriverCapability = (typeof CLOUDDRIVE_DRIVER_CAPABILITIES)[number]

/**
 * The drivers that complete authorization through the shared OAuth callback. The list is duplicated
 * from the worker provider table on purpose: the client only needs to know which buttons to show and
 * which callback path to print, never a client secret or a token endpoint.
 */
export const CLOUDDRIVE_OAUTH_DRIVER_IDS = [
  'onedrive', 'dropbox', 'google_drive', 'google_photo', 'yandex', 'aliyundrive_open', 'baidu_netdisk',
] as const

export function cloudDriveOAuthCallbackPath(driverId: string): string {
  return `/api/clouddrive/oauth/${driverId}/callback`
}

export function isCloudDriveOAuthDriver(driverId: string): boolean {
  return (CLOUDDRIVE_OAUTH_DRIVER_IDS as readonly string[]).includes(driverId)
}

export type CloudDriveDriverCapabilities = Readonly<Record<CloudDriveDriverCapability, boolean>>

export const CLOUDDRIVE_DRIVER_FIELD_TYPES = ['text', 'password', 'url', 'number', 'boolean', 'select'] as const
export type CloudDriveDriverFieldType = (typeof CLOUDDRIVE_DRIVER_FIELD_TYPES)[number]

export interface CloudDriveDriverField {
  key: string
  /** `clouddrive.driver.field.<key>` */
  labelKey: string
  type: CloudDriveDriverFieldType
  /** A secret is stored through the credential vault and never returned to the client. */
  location: 'config' | 'credentials'
  required?: boolean
  secret?: boolean
  defaultValue?: string | number | boolean
  placeholder?: string
  /** `clouddrive.driver.field.<key>_hint` */
  hintKey?: string
  options?: readonly { value: string; labelKey: string }[]
}

export interface CloudDriveDriverDefinition {
  id: string
  /** `clouddrive.driver.<id>` */
  nameKey: string
  group: CloudDriveDriverGroup
  /** False means the id is declared for the roadmap but cannot be selected yet. */
  implemented: boolean
  /** False for a driver that exists only as the built-in primary mount (R2). */
  mountable: boolean
  capabilities: CloudDriveDriverCapabilities
  fields: readonly CloudDriveDriverField[]
  /** The credential combinations that satisfy authentication; empty means no authentication. */
  authAnyOf?: readonly (readonly string[])[]
  /** `clouddrive.driver.reason.<id>` when an implemented driver has a platform limit. */
  noteKey?: string
}

function capabilities(overrides: Partial<CloudDriveDriverCapabilities> = {}): CloudDriveDriverCapabilities {
  return {
    read: true, write: false, mkdir: false, rename: false, move: false,
    copy: false, delete: false, directLink: false, range: false, share: false,
    ...overrides,
  }
}

const READ_ONLY = capabilities({ range: true })

function fieldSlug(key: string): string {
  return key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
}

function field(
  key: string,
  type: CloudDriveDriverFieldType,
  location: 'config' | 'credentials',
  extra: Partial<CloudDriveDriverField> = {},
): CloudDriveDriverField {
  return {
    key,
    labelKey: `clouddrive.driver.field.${fieldSlug(key)}`,
    type,
    location,
    ...(type === 'password' ? { secret: true } : {}),
    ...extra,
  }
}

/** `directLink` is the one capability whose id is not already a message-key segment. */
export function driverCapabilityKey(capability: CloudDriveDriverCapability): string {
  return capability === 'directLink' ? 'direct_link' : capability
}

const S3_FIELDS = [
  field('provider', 'select', 'config', {
    defaultValue: 'other',
    options: [
      { value: 'r2', labelKey: 'clouddrive.admin.storage.provider_r2' },
      { value: 'b2', labelKey: 'clouddrive.admin.storage.provider_b2' },
      { value: 'aws', labelKey: 'clouddrive.admin.storage.provider_aws' },
      { value: 'oss', labelKey: 'clouddrive.admin.storage.provider_oss' },
      { value: 'other', labelKey: 'clouddrive.admin.storage.provider_other' },
    ],
  }),
  field('endpoint', 'url', 'config', { required: true, placeholder: 'https://s3.example.com' }),
  field('bucketName', 'text', 'config', { required: true }),
  field('region', 'text', 'config', { defaultValue: 'auto' }),
  field('pathStyle', 'boolean', 'config', { defaultValue: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('customHost', 'url', 'config'),
  field('accessKeyId', 'text', 'credentials'),
  field('secretAccessKey', 'password', 'credentials', { secret: true }),
] as const

const WEBDAV_FIELDS = [
  field('baseUrl', 'url', 'config', { required: true, placeholder: 'https://dav.example.com/dav' }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('username', 'text', 'credentials'),
  field('password', 'password', 'credentials', { secret: true }),
] as const

const GITHUB_FIELDS = [
  field('repo', 'text', 'config', { required: true, placeholder: 'owner/name' }),
  field('branch', 'text', 'config', { placeholder: 'main' }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('token', 'password', 'credentials', { secret: true }),
] as const

const HUGGINGFACE_FIELDS = [
  field('repo', 'text', 'config', { required: true, placeholder: 'owner/name' }),
  field('repoType', 'select', 'config', {
    defaultValue: 'model',
    options: [
      { value: 'model', labelKey: 'clouddrive.storage.repo_type_model' },
      { value: 'dataset', labelKey: 'clouddrive.storage.repo_type_dataset' },
    ],
  }),
  field('revision', 'text', 'config', { defaultValue: 'main' }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('token', 'password', 'credentials', { secret: true }),
] as const

const DISCORD_FIELDS = [
  field('channelId', 'text', 'config', { required: true }),
  field('botToken', 'password', 'credentials', { secret: true }),
] as const

const TELEGRAM_FIELDS = [
  field('chatId', 'text', 'config', { required: true }),
  field('botToken', 'password', 'credentials', { secret: true }),
] as const

const ONEDRIVE_FIELDS = [
  field('driveId', 'text', 'config'),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('accessToken', 'password', 'credentials', { secret: true }),
  field('refreshToken', 'password', 'credentials', { secret: true }),
  field('clientId', 'text', 'credentials'),
  field('clientSecret', 'password', 'credentials', { secret: true }),
] as const

const GOOGLE_DRIVE_FIELDS = [
  field('folderId', 'text', 'config', { defaultValue: 'root' }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('accessToken', 'password', 'credentials', { secret: true }),
  field('refreshToken', 'password', 'credentials', { secret: true }),
  field('clientId', 'text', 'credentials'),
  field('clientSecret', 'password', 'credentials', { secret: true }),
] as const

const PAN123_FIELDS = [
  field('username', 'text', 'config', { hintKey: 'clouddrive.driver.field.username_hint' }),
  field('password', 'password', 'credentials', { secret: true }),
  field('cookie', 'password', 'credentials', { secret: true, hintKey: 'clouddrive.driver.field.cookie_hint' }),
  field('accessToken', 'password', 'credentials', {
    secret: true,
    hintKey: 'clouddrive.driver.field.access_token_hint',
  }),
  field('rootId', 'text', 'config', { defaultValue: '0', placeholder: '0' }),
  field('platform', 'select', 'config', {
    defaultValue: 'web',
    options: [
      { value: 'web', labelKey: 'clouddrive.driver.field.platform_web' },
      { value: 'android', labelKey: 'clouddrive.driver.field.platform_android' },
    ],
  }),
] as const

/** Batch A schemas. Secrets live in the credential vault, never in `config`. */
const R2_FIELDS = [
  field('mode', 'select', 'config', {
    defaultValue: 'auto',
    options: [
      { value: 'auto', labelKey: 'clouddrive.driver.field.r2_mode_auto' },
      { value: 'binding', labelKey: 'clouddrive.driver.field.r2_mode_binding' },
    ],
  }),
  field('bucketBinding', 'text', 'config', { placeholder: 'FILES' }),
  field('accountId', 'text', 'config', { hintKey: 'clouddrive.driver.field.account_id_hint' }),
  field('bucket', 'text', 'config', { required: true }),
  field('endpoint', 'url', 'config', { placeholder: 'https://<account>.r2.cloudflarestorage.com' }),
  field('region', 'text', 'config', { defaultValue: 'auto' }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('accessKeyId', 'text', 'credentials', { required: true }),
  field('secretAccessKey', 'password', 'credentials', { secret: true, required: true }),
  field('sessionToken', 'password', 'credentials', { secret: true }),
] as const

const AZURE_BLOB_FIELDS = [
  field('endpoint', 'url', 'config', { required: true, placeholder: 'https://account.blob.core.windows.net' }),
  field('accessKey', 'password', 'credentials', { secret: true, required: true }),
  field('containerName', 'text', 'config', { required: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const USS_FIELDS = [
  field('bucket', 'text', 'config', { required: true }),
  field('endpoint', 'url', 'config', { defaultValue: 'https://v0.api.upyun.com' }),
  field('operatorName', 'text', 'config', { required: true }),
  field('operatorPassword', 'password', 'credentials', { secret: true, required: true }),
  field('antiTheftChainToken', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const BUNNY_FIELDS = [
  field('storageZoneName', 'text', 'config', { required: true }),
  field('accessKey', 'password', 'credentials', { secret: true, required: true }),
  field('endpoint', 'url', 'config', { defaultValue: 'https://storage.bunnycdn.com' }),
  field('cdnBaseUrl', 'url', 'config'),
  field('cdnTokenKey', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const SEAFILE_FIELDS = [
  field('address', 'url', 'config', { required: true }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('token', 'password', 'credentials', { secret: true }),
  field('repoId', 'text', 'config'),
  field('repoPwd', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const CLOUDREVE_FIELDS = [
  field('address', 'url', 'config', { required: true }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('token', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const KODBOX_FIELDS = [
  field('address', 'url', 'config', { required: true }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const ALIST_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('token', 'password', 'credentials', { secret: true }),
  field('metaPassword', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const OPENLIST_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('token', 'password', 'credentials', { secret: true }),
  field('metaPassword', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const OPENLIST_SHARE_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('sid', 'text', 'config', { required: true }),
  field('pwd', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const TELDRIVE_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('accessToken', 'password', 'credentials', { secret: true, required: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const MISSKEY_FIELDS = [
  field('endpoint', 'url', 'config', { required: true }),
  field('accessToken', 'password', 'credentials', { secret: true, required: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const EMBY_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('apiKey', 'password', 'credentials', { secret: true }),
  field('userId', 'text', 'config', { hintKey: 'clouddrive.driver.field.user_id_hint' }),
  field('username', 'text', 'config'),
  field('password', 'password', 'credentials', { secret: true }),
  field('linkMethod', 'select', 'config', {
    defaultValue: 'stream',
    options: [
      { value: 'stream', labelKey: 'clouddrive.driver.field.link_method_stream' },
      { value: 'download', labelKey: 'clouddrive.driver.field.link_method_download' },
    ],
  }),
  field('rootFolderId', 'text', 'config', { defaultValue: '1' }),
] as const

const IPFS_FIELDS = [
  field('endpoint', 'url', 'config', { required: true, placeholder: 'http://127.0.0.1:5001' }),
  field('mode', 'select', 'config', {
    defaultValue: 'ipfs',
    options: [
      { value: 'ipfs', labelKey: 'clouddrive.driver.field.mode_ipfs' },
      { value: 'ipns', labelKey: 'clouddrive.driver.field.mode_ipns' },
      { value: 'mfs', labelKey: 'clouddrive.driver.field.mode_mfs' },
    ],
  }),
  field('gateway', 'url', 'config', { placeholder: 'https://ipfs.example.com' }),
  field('rootPath', 'text', 'config'),
] as const

const CNB_FIELDS = [
  field('repo', 'text', 'config', { required: true, placeholder: 'org/repo' }),
  field('token', 'password', 'credentials', { secret: true, required: true }),
  field('useTagName', 'boolean', 'config', { defaultValue: false }),
  field('defaultBranch', 'text', 'config', { defaultValue: 'main' }),
] as const

const GITHUB_RELEASES_FIELDS = [
  field('repoStructure', 'text', 'config', { required: true, placeholder: 'releases:owner/name' }),
  field('token', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
  field('showReadme', 'boolean', 'config', { defaultValue: true }),
  field('showSourceCode', 'boolean', 'config', { defaultValue: false }),
  field('showAllVersion', 'boolean', 'config', { defaultValue: false }),
  field('perPage', 'number', 'config', { defaultValue: 30 }),
  field('maxPage', 'number', 'config', { defaultValue: 0 }),
  field('ghProxy', 'url', 'config'),
] as const

const LENOVO_FIELDS = [
  field('shareId', 'text', 'config', { required: true }),
  field('sharePwd', 'password', 'credentials', { secret: true, required: true }),
  field('host', 'url', 'config'),
  field('rootPath', 'text', 'config'),
] as const

const SHARELINK_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('password', 'password', 'credentials', { secret: true }),
  field('rootPath', 'text', 'config'),
] as const

const AUTOINDEX_FIELDS = [
  field('url', 'url', 'config', { required: true }),
  field('rootPath', 'text', 'config'),
  field('itemXpath', 'text', 'config'),
  field('nameXpath', 'text', 'config'),
  field('sizeXpath', 'text', 'config'),
  field('modifiedXpath', 'text', 'config'),
] as const

const VIRTUAL_FIELDS = [
  field('numFile', 'number', 'config', { defaultValue: 100 }),
  field('numFolder', 'number', 'config', { defaultValue: 10 }),
  field('minFileSize', 'number', 'config', { defaultValue: 0 }),
  field('maxFileSize', 'number', 'config', { defaultValue: 1_048_576 }),
  field('rootPath', 'text', 'config'),
] as const

const URL_TREE_FIELDS = [
  field('urlStructure', 'text', 'config', { required: true }),
  field('writable', 'boolean', 'config', { defaultValue: false }),
  field('headSize', 'boolean', 'config', { defaultValue: false }),
  field('rootPath', 'text', 'config'),
] as const

const STRM_FIELDS = [
  field('paths', 'text', 'config', { required: true, placeholder: '/mnt:video' }),
  field('siteUrl', 'url', 'config'),
  field('pathPrefix', 'text', 'config', { defaultValue: '/d' }),
  field('downloadFileTypes', 'text', 'config', { defaultValue: 'ass,srt,vtt,sub,strm' }),
  field('filterFileTypes', 'text', 'config', { defaultValue: 'mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac' }),
  field('encodePath', 'boolean', 'config', { defaultValue: false }),
  field('withoutUrl', 'boolean', 'config', { defaultValue: false }),
  field('withSign', 'boolean', 'config', { defaultValue: false }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const CHUNK_FIELDS = [
  field('remotePath', 'text', 'config', { required: true, hintKey: 'clouddrive.driver.field.remote_path_hint' }),
  field('partSize', 'number', 'config', { required: true, defaultValue: 4_194_304 }),
  field('chunkLargeFileOnly', 'boolean', 'config', { defaultValue: false }),
  field('chunkPrefix', 'text', 'config', { defaultValue: '[openlist_chunk]' }),
  field('customExt', 'text', 'config'),
  field('storeHash', 'boolean', 'config', { defaultValue: false }),
  field('numListWorkers', 'number', 'config'),
  field('showHidden', 'boolean', 'config', { defaultValue: false }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const CRYPT_FIELDS = [
  field('remotePath', 'text', 'config', { required: true, hintKey: 'clouddrive.driver.field.remote_path_hint' }),
  field('password', 'password', 'credentials', { secret: true, required: true }),
  field('salt', 'password', 'credentials', { secret: true }),
  field('filenameEncryption', 'select', 'config', {
    defaultValue: 'off',
    options: [
      { value: 'off', labelKey: 'clouddrive.driver.field.filename_encryption_off' },
      { value: 'standard', labelKey: 'clouddrive.driver.field.filename_encryption_standard' },
      { value: 'obfuscate', labelKey: 'clouddrive.driver.field.filename_encryption_obfuscate' },
    ],
  }),
  field('encryptedSuffix', 'text', 'config', { defaultValue: '.bin' }),
  field('showHidden', 'boolean', 'config', { defaultValue: false }),
  field('rootPath', 'text', 'config', { placeholder: '/' }),
] as const

const ALIAS_FIELDS = [
  field('paths', 'text', 'config', { required: true, placeholder: 'video:/nas/video' }),
  field('readConflictPolicy', 'select', 'config', {
    defaultValue: 'first',
    options: [
      { value: 'first', labelKey: 'clouddrive.driver.field.conflict_first' },
      { value: 'random', labelKey: 'clouddrive.driver.field.conflict_random' },
      { value: 'all', labelKey: 'clouddrive.driver.field.conflict_all' },
    ],
  }),
  field('writeConflictPolicy', 'select', 'config', {
    defaultValue: 'first',
    options: [
      { value: 'disabled', labelKey: 'clouddrive.driver.field.conflict_disabled' },
      { value: 'first', labelKey: 'clouddrive.driver.field.conflict_first' },
      { value: 'deterministic', labelKey: 'clouddrive.driver.field.conflict_deterministic' },
      { value: 'all', labelKey: 'clouddrive.driver.field.conflict_all' },
      { value: 'all_strict', labelKey: 'clouddrive.driver.field.conflict_all_strict' },
    ],
  }),
  field('putConflictPolicy', 'select', 'config', {
    defaultValue: 'first',
    options: [
      { value: 'disabled', labelKey: 'clouddrive.driver.field.conflict_disabled' },
      { value: 'first', labelKey: 'clouddrive.driver.field.conflict_first' },
      { value: 'deterministic', labelKey: 'clouddrive.driver.field.conflict_deterministic' },
      { value: 'all', labelKey: 'clouddrive.driver.field.conflict_all' },
      { value: 'all_strict', labelKey: 'clouddrive.driver.field.conflict_all_strict' },
      { value: 'random', labelKey: 'clouddrive.driver.field.conflict_random' },
    ],
  }),
  field('orderBy', 'text', 'config', { defaultValue: 'name' }),
  field('orderDirection', 'text', 'config', { defaultValue: 'asc' }),
] as const

const OAUTH_TOKEN_FIELDS = [
  field('accessToken', 'password', 'credentials', {
    secret: true,
    hintKey: 'clouddrive.driver.field.access_token_hint',
  }),
  field('refreshToken', 'password', 'credentials', {
    secret: true,
    hintKey: 'clouddrive.driver.field.refresh_token_hint',
  }),
  field('clientId', 'text', 'credentials', { hintKey: 'clouddrive.driver.field.client_id_hint' }),
  field('clientSecret', 'password', 'credentials', { secret: true }),
] as const

const DROPBOX_FIELDS = [
  field('rootPath', 'text', 'config', { placeholder: '/', hintKey: 'clouddrive.driver.field.root_path_hint' }),
  ...OAUTH_TOKEN_FIELDS,
] as const

const YANDEX_FIELDS = [
  field('rootPath', 'text', 'config', { placeholder: '/', hintKey: 'clouddrive.driver.field.root_path_hint' }),
  ...OAUTH_TOKEN_FIELDS,
] as const

export const CLOUDDRIVE_DRIVERS: readonly CloudDriveDriverDefinition[] = [
  { id: '115open', nameKey: 'clouddrive.driver.115open', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '115_share', nameKey: 'clouddrive.driver.115_share', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '123_open', nameKey: 'clouddrive.driver.123_open', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: '123pan', nameKey: 'clouddrive.driver.123pan', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, delete: true, directLink: true, range: true }),
    fields: PAN123_FIELDS,
    authAnyOf: [['username', 'password'], ['cookie'], ['accessToken']],
  },
  { id: '123_share', nameKey: 'clouddrive.driver.123_share', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '139', nameKey: 'clouddrive.driver.139', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '189', nameKey: 'clouddrive.driver.189', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '189pc', nameKey: 'clouddrive.driver.189pc', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: '189_tv', nameKey: 'clouddrive.driver.189_tv', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'alidoc', nameKey: 'clouddrive.driver.alidoc', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'aliyundrive_open', nameKey: 'clouddrive.driver.aliyundrive_open', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'aliyundrive_share', nameKey: 'clouddrive.driver.aliyundrive_share', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'baidu_netdisk', nameKey: 'clouddrive.driver.baidu_netdisk', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'baidu_photo', nameKey: 'clouddrive.driver.baidu_photo', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'chaoxing', nameKey: 'clouddrive.driver.chaoxing', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'cloudreve_v3', nameKey: 'clouddrive.driver.cloudreve_v3', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: CLOUDREVE_FIELDS,
    authAnyOf: [['token'], ['username', 'password']],
    noteKey: 'clouddrive.driver.reason.cloudreve_v3',
  },
  {
    id: 'cloudreve_v4', nameKey: 'clouddrive.driver.cloudreve_v4', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: CLOUDREVE_FIELDS,
    authAnyOf: [['token'], ['username', 'password']],
    noteKey: 'clouddrive.driver.reason.cloudreve_v4',
  },
  { id: 'ctfile', nameKey: 'clouddrive.driver.ctfile', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'doubao', nameKey: 'clouddrive.driver.doubao', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'guangyapan', nameKey: 'clouddrive.driver.guangyapan', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'kodbox', nameKey: 'clouddrive.driver.kodbox', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: KODBOX_FIELDS,
    authAnyOf: [['username', 'password']],
  },
  { id: 'lanzou', nameKey: 'clouddrive.driver.lanzou', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'lenovonas_share', nameKey: 'clouddrive.driver.lenovonas_share', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: LENOVO_FIELDS,
    authAnyOf: [['shareId', 'sharePwd']],
  },
  { id: 'mediatrack', nameKey: 'clouddrive.driver.mediatrack', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'mopan', nameKey: 'clouddrive.driver.mopan', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'netease_music', nameKey: 'clouddrive.driver.netease_music', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'openlist', nameKey: 'clouddrive.driver.openlist', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: OPENLIST_FIELDS,
    authAnyOf: [['token'], ['username', 'password']],
    noteKey: 'clouddrive.driver.reason.openlist',
  },
  {
    id: 'openlist_share', nameKey: 'clouddrive.driver.openlist_share', group: 'china', implemented: true, mountable: true,
    capabilities: capabilities({ directLink: true, range: true }),
    fields: OPENLIST_SHARE_FIELDS,
  },
  { id: 'pikpak', nameKey: 'clouddrive.driver.pikpak', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'pikpak_share', nameKey: 'clouddrive.driver.pikpak_share', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'quark', nameKey: 'clouddrive.driver.quark', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'quark_open', nameKey: 'clouddrive.driver.quark_open', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'quark_uc_tv', nameKey: 'clouddrive.driver.quark_uc_tv', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'teambition', nameKey: 'clouddrive.driver.teambition', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'terabox', nameKey: 'clouddrive.driver.terabox', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'thunder', nameKey: 'clouddrive.driver.thunder', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'weiyun', nameKey: 'clouddrive.driver.weiyun', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'wopan', nameKey: 'clouddrive.driver.wopan', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'wps', nameKey: 'clouddrive.driver.wps', group: 'china', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },

  {
    id: 'alist_v3', nameKey: 'clouddrive.driver.alist_v3', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: ALIST_FIELDS,
    authAnyOf: [['token'], ['username', 'password']],
  },
  { id: 'degoo', nameKey: 'clouddrive.driver.degoo', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'dropbox', nameKey: 'clouddrive.driver.dropbox', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: DROPBOX_FIELDS,
    authAnyOf: [['refreshToken'], ['accessToken']],
  },
  { id: 'febbox', nameKey: 'clouddrive.driver.febbox', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'google_photo', nameKey: 'clouddrive.driver.google_photo', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'halalcloud_open', nameKey: 'clouddrive.driver.halalcloud_open', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'mediafire', nameKey: 'clouddrive.driver.mediafire', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'mega', nameKey: 'clouddrive.driver.mega', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'misskey', nameKey: 'clouddrive.driver.misskey', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: MISSKEY_FIELDS,
    authAnyOf: [['accessToken']],
    noteKey: 'clouddrive.driver.reason.misskey',
  },
  {
    id: 'onedrive', nameKey: 'clouddrive.driver.onedrive', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: ONEDRIVE_FIELDS,
    authAnyOf: [['refreshToken'], ['accessToken']],
  },
  { id: 'onedrive_app', nameKey: 'clouddrive.driver.onedrive_app', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'onedrive_sharelink', nameKey: 'clouddrive.driver.onedrive_sharelink', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: SHARELINK_FIELDS,
  },
  { id: 'proton_drive', nameKey: 'clouddrive.driver.proton_drive', group: 'international', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'seafile', nameKey: 'clouddrive.driver.seafile', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: SEAFILE_FIELDS,
    authAnyOf: [['token'], ['username', 'password']],
  },
  {
    id: 'teldrive', nameKey: 'clouddrive.driver.teldrive', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, move: true, delete: true, directLink: true, range: true }),
    fields: TELDRIVE_FIELDS,
    authAnyOf: [['accessToken']],
    noteKey: 'clouddrive.driver.reason.teldrive',
  },
  {
    id: 'yandex', nameKey: 'clouddrive.driver.yandex', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: YANDEX_FIELDS,
    authAnyOf: [['refreshToken'], ['accessToken']],
  },
  {
    id: 'google_drive', nameKey: 'clouddrive.driver.google_drive', group: 'international', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: GOOGLE_DRIVE_FIELDS,
    authAnyOf: [['refreshToken'], ['accessToken']],
  },

  {
    id: 's3', nameKey: 'clouddrive.driver.s3', group: 'object', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: S3_FIELDS,
  },
  {
    id: 'r2', nameKey: 'clouddrive.driver.r2', group: 'object', implemented: true, mountable: false,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: R2_FIELDS,
    authAnyOf: [['accessKeyId', 'secretAccessKey']],
    noteKey: 'clouddrive.driver.reason.r2',
  },
  {
    id: 'azure_blob', nameKey: 'clouddrive.driver.azure_blob', group: 'object', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: AZURE_BLOB_FIELDS,
    authAnyOf: [['accessKey']],
  },
  {
    id: 'bunny_storage', nameKey: 'clouddrive.driver.bunny_storage', group: 'object', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: BUNNY_FIELDS,
    authAnyOf: [['accessKey']],
  },
  {
    id: 'uss', nameKey: 'clouddrive.driver.uss', group: 'object', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: USS_FIELDS,
    authAnyOf: [['operatorName', 'operatorPassword']],
  },
  {
    id: 'ipfs_api', nameKey: 'clouddrive.driver.ipfs_api', group: 'object', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: IPFS_FIELDS,
  },
  { id: 'cloudflare_imgbed', nameKey: 'clouddrive.driver.cloudflare_imgbed', group: 'object', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },

  {
    id: 'autoindex', nameKey: 'clouddrive.driver.autoindex', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: AUTOINDEX_FIELDS,
  },
  {
    id: 'strm', nameKey: 'clouddrive.driver.strm', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: STRM_FIELDS,
  },
  {
    id: 'chunk', nameKey: 'clouddrive.driver.chunk', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: CHUNK_FIELDS,
  },
  {
    id: 'crypt', nameKey: 'clouddrive.driver.crypt', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: CRYPT_FIELDS,
    authAnyOf: [['password']],
  },
  {
    id: 'alias', nameKey: 'clouddrive.driver.alias', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, directLink: true, range: true }),
    fields: ALIAS_FIELDS,
  },
  {
    id: 'url_tree', nameKey: 'clouddrive.driver.url_tree', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, copy: true, delete: true, range: true }),
    fields: URL_TREE_FIELDS,
  },
  {
    id: 'virtual', nameKey: 'clouddrive.driver.virtual', group: 'virtual', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: VIRTUAL_FIELDS,
  },

  {
    id: 'webdav', nameKey: 'clouddrive.driver.webdav', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ write: true, mkdir: true, rename: true, move: true, delete: true, range: true }),
    fields: WEBDAV_FIELDS,
    authAnyOf: [['username', 'password']],
  },
  { id: 'ftp', nameKey: 'clouddrive.driver.ftp', group: 'protocol', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'sftp', nameKey: 'clouddrive.driver.sftp', group: 'protocol', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'smb', nameKey: 'clouddrive.driver.smb', group: 'protocol', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  { id: 'local', nameKey: 'clouddrive.driver.local', group: 'protocol', implemented: false, mountable: true, capabilities: READ_ONLY, fields: [] },
  {
    id: 'emby', nameKey: 'clouddrive.driver.emby', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ directLink: true, range: true }),
    fields: EMBY_FIELDS,
    authAnyOf: [['apiKey', 'userId'], ['username', 'password']],
  },
  {
    id: 'github', nameKey: 'clouddrive.driver.github', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: GITHUB_FIELDS,
  },
  {
    id: 'github_releases', nameKey: 'clouddrive.driver.github_releases', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: GITHUB_RELEASES_FIELDS,
  },
  {
    id: 'cnb_releases', nameKey: 'clouddrive.driver.cnb_releases', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ mkdir: true, rename: true, delete: true, range: true }),
    fields: CNB_FIELDS,
    authAnyOf: [['token']],
    noteKey: 'clouddrive.driver.reason.cnb_releases',
  },

  {
    id: 'huggingface', nameKey: 'clouddrive.driver.huggingface', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: HUGGINGFACE_FIELDS,
  },
  {
    id: 'discord', nameKey: 'clouddrive.driver.discord', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({ range: true }),
    fields: DISCORD_FIELDS,
  },
  {
    id: 'telegram', nameKey: 'clouddrive.driver.telegram', group: 'protocol', implemented: true, mountable: true,
    capabilities: capabilities({}),
    fields: TELEGRAM_FIELDS,
    noteKey: 'clouddrive.driver.reason.telegram',
  },
]

export function findCloudDriveDriver(id: string): CloudDriveDriverDefinition | null {
  return CLOUDDRIVE_DRIVERS.find((driver) => driver.id === id) ?? null
}

export function mountableCloudDriveDrivers(): readonly CloudDriveDriverDefinition[] {
  return CLOUDDRIVE_DRIVERS.filter((driver) => driver.mountable)
}

export function implementedCloudDriveDrivers(): readonly CloudDriveDriverDefinition[] {
  return mountableCloudDriveDrivers().filter((driver) => driver.implemented)
}

export function writableCloudDriveDriver(type: string): boolean {
  return findCloudDriveDriver(type)?.capabilities.write === true
}

export function driverCapabilityLabels(driver: CloudDriveDriverDefinition | null): CloudDriveDriverCapability[] {
  return driver ? CLOUDDRIVE_DRIVER_CAPABILITIES.filter((capability) => driver.capabilities[capability]) : []
}
