import { z } from 'zod'
import {
  FILE_KINDS,
  HISTORY_ENTRY_MAX_BYTES,
  MAX_ENVIRONMENTS,
  MAX_FILE_BYTES,
  MAX_GLOBAL_VARIABLES,
  MAX_KV_KEY_CHARS,
  MAX_KV_VALUE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_MULTIPART_FIELDS,
  MAX_NAME_CHARS,
  MAX_NODES,
  MAX_PROXY_HEADERS,
  MAX_SCRIPT_CHARS,
  MAX_TAGS,
  MAX_TAGS_PER_NODE,
  MAX_TAG_NAME_CHARS,
  MAX_TEXT_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MAX_URL_CHARS,
  MAX_VARIABLES_PER_ENV,
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
  id: z.string().min(1).max(256),
  key: z.string().max(MAX_KV_KEY_CHARS),
  value: z.string().max(MAX_KV_VALUE_CHARS),
  enabled: z.boolean(),
  isFile: z.boolean().optional(),
  fileId: ApiTesterIdSchema.optional(),
  fileName: z.string().max(200).optional(),
  fileSize: z.number().int().min(0).optional(),
  fileType: z.string().max(200).optional(),
})

const HeadersSchema = z.array(z.object({ key: HeaderNameSchema, value: HeaderValueSchema })).max(MAX_PROXY_HEADERS)

export const MultipartFieldSchema = z.object({
  key: z.string().trim().min(1).max(MAX_KV_KEY_CHARS),
  value: z.string().max(MAX_KV_VALUE_CHARS),
  isFile: z.boolean().optional(),
  fileId: ApiTesterIdSchema.optional(),
  fileName: z.string().max(200).regex(/^[^\r\n\0]*$/, 'Invalid file name').optional(),
  contentType: z.string().max(200).regex(/^[^\r\n\0]*$/, 'Invalid content type').optional(),
})

export const ProxyRequestSchema = z
  .object({
    method: z.enum(HTTP_METHODS),
    url: z.string().trim().min(1).max(MAX_URL_CHARS),
    headers: HeadersSchema,
    body: z.string().max(MAX_TEXT_BODY_BYTES).optional(),
    bodyFileId: ApiTesterIdSchema.optional(),
    multipart: z.array(MultipartFieldSchema).max(MAX_MULTIPART_FIELDS).optional(),
    redirect: z.enum(['follow', 'manual']),
    timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
  })
  .superRefine((value, ctx) => {
    const sources = [value.body !== undefined, value.bodyFileId !== undefined, value.multipart !== undefined]
    if (sources.filter(Boolean).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'body, bodyFileId and multipart are mutually exclusive' })
    }
    for (const [index, field] of (value.multipart ?? []).entries()) {
      if (field.isFile && !field.fileId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['multipart', index, 'fileId'], message: 'A file field needs a fileId' })
      }
    }
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

const HttpMethodSchema = z.enum(HTTP_METHODS)
const BodyTypeSchema = z.enum(['none', 'json', 'form-urlencoded', 'form-data', 'raw', 'binary'])
const AuthTypeSchema = z.enum(['none', 'bearer', 'basic', 'apikey-header', 'apikey-query', 'oauth2'])

const OAuth2ConfigSchema = z.object({
  authUrl: z.string().max(MAX_URL_CHARS).optional(),
  tokenUrl: z.string().max(MAX_URL_CHARS).optional(),
  clientId: z.string().max(2_048).optional(),
  clientSecret: z.string().max(4_096).optional(),
  scope: z.string().max(2_048).optional(),
  accessToken: z.string().max(16_384).optional(),
  refreshToken: z.string().max(16_384).optional(),
  tokenType: z.string().max(128).optional(),
  expiresAt: z.number().optional(),
}).partial().passthrough()

const AuthConfigSchema = z.object({
  type: AuthTypeSchema.optional(),
  token: z.string().max(16_384).optional(),
  username: z.string().max(4_096).optional(),
  password: z.string().max(4_096).optional(),
  keyName: z.string().max(200).optional(),
  keyValue: z.string().max(8_192).optional(),
  oauth2: OAuth2ConfigSchema.optional(),
}).partial().passthrough()

const HttpRequestConfigSchema = z.object({
  method: HttpMethodSchema.optional(),
  url: z.string().max(MAX_URL_CHARS).optional(),
  params: z.array(KeyValueSchema).max(100).optional(),
  headers: z.array(KeyValueSchema).max(100).optional(),
  bodyType: BodyTypeSchema.optional(),
  body: z.string().max(MAX_TEXT_BODY_BYTES).optional(),
  bodyFileId: ApiTesterIdSchema.optional(),
  bodyFileName: z.string().max(200).optional(),
  bodyFileSize: z.number().int().min(0).optional(),
  formFields: z.array(KeyValueSchema).max(100).optional(),
  auth: AuthConfigSchema.optional(),
  graphqlQuery: z.string().max(MAX_SCRIPT_CHARS).optional(),
  graphqlVariables: z.string().max(MAX_SCRIPT_CHARS).optional(),
}).partial().passthrough()

const WebSocketConfigSchema = z.object({
  url: z.string().max(MAX_URL_CHARS).optional(),
  headers: z.array(KeyValueSchema).max(100).optional(),
}).partial().passthrough()

const CollectionNodeSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.enum(['folder', 'request']),
  name: z.string().max(MAX_NAME_CHARS),
  parentId: z.string().max(256).nullable().optional(),
  order: z.number().optional(),
  collapsed: z.boolean().optional(),
  kind: z.enum(['rest', 'graphql', 'websocket']).optional(),
  request: HttpRequestConfigSchema.optional(),
  ws: WebSocketConfigSchema.optional(),
  tags: z.array(z.string().max(64)).max(MAX_TAGS_PER_NODE).optional(),
  description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
  preScript: z.string().max(MAX_SCRIPT_CHARS).optional(),
  tests: z.string().max(MAX_SCRIPT_CHARS).optional(),
  lastStatus: z.number().optional(),
  updatedAt: z.number().optional(),
}).passthrough()

const EnvVariableSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().max(MAX_KV_KEY_CHARS),
  value: z.string().max(MAX_KV_VALUE_CHARS),
  enabled: z.boolean(),
  secret: z.boolean().optional(),
}).passthrough()

const EnvironmentSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(MAX_NAME_CHARS),
  color: z.string().max(32).optional(),
  variables: z.array(EnvVariableSchema).max(MAX_VARIABLES_PER_ENV),
}).passthrough()

const TagSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(MAX_TAG_NAME_CHARS),
  parentId: z.string().max(256).nullable(),
  color: z.string().max(32),
  sortOrder: z.number(),
  createdAt: z.number(),
}).passthrough()

const CookieRecordSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  value: z.string().max(MAX_KV_VALUE_CHARS),
  domain: z.string().max(255),
  path: z.string().max(512),
  expiresAt: z.number().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
}).passthrough()

export const StateDataSchema = z
  .object({
    version: z.number().int().min(1).max(100),
    nodes: z.array(CollectionNodeSchema).max(MAX_NODES),
    environments: z.array(EnvironmentSchema).max(MAX_ENVIRONMENTS),
    globalVariables: z.array(EnvVariableSchema).max(MAX_GLOBAL_VARIABLES),
    tags: z.array(TagSchema).max(MAX_TAGS),
    cookies: z.array(CookieRecordSchema).max(500).optional(),
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
