import { z } from 'zod'
import {
  FILE_KINDS,
  HISTORY_ENTRY_MAX_BYTES,
  MAX_ENVIRONMENTS,
  MAX_FILE_BYTES,
  MAX_GLOBAL_VARIABLES,
  MAX_KV_KEY_CHARS,
  MAX_KV_VALUE_CHARS,
  MAX_NODES,
  MAX_PROXY_HEADERS,
  MAX_TAGS,
  MAX_TEXT_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MAX_URL_CHARS,
  MAX_WS_HEADERS,
  MIN_TIMEOUT_MS,
} from './limits'
import { isApiTesterId } from './ids'
import { HTTP_METHODS } from './types'

export const ApiTesterIdSchema = z.string().refine(isApiTesterId, 'Invalid id')

const WorkspaceNameSchema = z.string().trim().min(1).max(80)
const WorkspaceColorSchema = z.string().trim().min(1).max(32)
const HeaderNameSchema = z.string().trim().min(1).max(200).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Invalid header name')
const HeaderValueSchema = z.string().max(MAX_KV_VALUE_CHARS).regex(/^[^\r\n\0]*$/, 'Invalid header value')

export const CreateWorkspaceSchema = z.object({
  name: WorkspaceNameSchema,
  color: WorkspaceColorSchema.optional(),
})

export const UpdateWorkspaceSchema = z.object({
  name: WorkspaceNameSchema.optional(),
  color: WorkspaceColorSchema.optional(),
})

export const KeyValueSchema = z.object({
  id: z.string().min(1).max(64),
  key: z.string().max(MAX_KV_KEY_CHARS),
  value: z.string().max(MAX_KV_VALUE_CHARS),
  enabled: z.boolean(),
  isFile: z.boolean().optional(),
})

const HeadersSchema = z.array(z.object({ key: HeaderNameSchema, value: HeaderValueSchema })).max(MAX_PROXY_HEADERS)

export const ProxyRequestSchema = z.object({
  method: z.enum(HTTP_METHODS),
  url: z.string().trim().min(1).max(MAX_URL_CHARS),
  headers: HeadersSchema,
  body: z.string().max(MAX_TEXT_BODY_BYTES).optional(),
  bodyFileId: ApiTesterIdSchema.optional(),
  redirect: z.enum(['follow', 'manual']),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
})

export const OAuthTokenRequestSchema = z.object({
  tokenUrl: z.string().trim().min(1).max(MAX_URL_CHARS),
  grantType: z.enum(['authorization_code', 'refresh_token']).optional(),
  code: z.string().max(16_384).optional(),
  redirectUri: z.string().max(MAX_URL_CHARS).optional(),
  clientId: z.string().max(2_048).optional(),
  clientSecret: z.string().max(4_096).optional(),
  refreshToken: z.string().max(16_384).optional(),
})

export const WsTicketRequestSchema = z.object({
  url: z.string().trim().min(1).max(4_096),
  headers: z.array(z.object({ key: HeaderNameSchema, value: HeaderValueSchema })).max(MAX_WS_HEADERS),
})

const SettingsSchema = z.object({
  followRedirects: z.boolean(),
  autoPrettify: z.boolean(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
  splitDirection: z.enum(['vertical', 'horizontal']),
  sidebarCollapsed: z.boolean(),
})

export const StateDataSchema = z
  .object({
    version: z.number().int().min(1).max(100),
    nodes: z.array(z.unknown()).max(MAX_NODES),
    environments: z.array(z.unknown()).max(MAX_ENVIRONMENTS),
    globalVariables: z.array(z.unknown()).max(MAX_GLOBAL_VARIABLES),
    tags: z.array(z.unknown()).max(MAX_TAGS),
    settings: SettingsSchema,
    activeEnvId: z.string().max(64).nullable(),
  })
  .passthrough()

export const StatePutSchema = z.object({
  workspaceId: ApiTesterIdSchema,
  rev: z.number().int().min(0),
  data: StateDataSchema,
})

export const HistoryEntrySchema = z.object({
  id: ApiTesterIdSchema,
  ts: z.number().int().min(0),
  data: z.unknown(),
})

export const HistoryAppendSchema = z.object({
  workspaceId: ApiTesterIdSchema,
  entry: HistoryEntrySchema,
})

export const WorkspaceIdQuerySchema = z.object({
  workspaceId: ApiTesterIdSchema,
})

export const FileKindSchema = z.enum(FILE_KINDS)

export const FileListQuerySchema = z.object({
  kind: FileKindSchema.optional(),
})

export const FILE_UPLOAD_LIMIT = MAX_FILE_BYTES + 64 * 1024
export const HISTORY_JSON_LIMIT = HISTORY_ENTRY_MAX_BYTES + 16 * 1024
export const STATE_JSON_LIMIT = 4_000_000 + 64 * 1024
export const PROXY_JSON_LIMIT = MAX_TEXT_BODY_BYTES + 128 * 1024
export const WS_TICKET_JSON_LIMIT = 128 * 1024
export const OAUTH_JSON_LIMIT = 64 * 1024
