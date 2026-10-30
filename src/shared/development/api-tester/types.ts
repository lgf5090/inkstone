import type { FileKind } from './limits'

export type { FileKind } from './limits'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

export type BodyType = 'none' | 'json' | 'form-urlencoded' | 'form-data' | 'raw' | 'binary'

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey-header' | 'apikey-query' | 'oauth2'

export type RequestKind = 'rest' | 'graphql' | 'websocket'

export interface KeyValue {
  id: string
  key: string
  value: string
  enabled: boolean
  isFile?: boolean
}

export interface OAuth2Config {
  authUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: number
}

export interface AuthConfig {
  type: AuthType
  token: string
  username: string
  password: string
  keyName: string
  keyValue: string
  oauth2?: OAuth2Config
}

export interface HttpRequestConfig {
  method: HttpMethod
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  bodyType: BodyType
  body: string
  bodyFileId?: string
  bodyFileName?: string
  bodyFileSize?: number
  formFields: KeyValue[]
  auth: AuthConfig
  graphqlQuery: string
  graphqlVariables: string
}

export interface WebSocketConfig {
  url: string
  headers: KeyValue[]
}

export interface CollectionNode {
  id: string
  type: 'folder' | 'request'
  name: string
  parentId: string | null
  order: number
  collapsed?: boolean
  kind?: RequestKind
  request?: HttpRequestConfig
  ws?: WebSocketConfig
  tags: string[]
  description?: string
  preScript?: string
  tests?: string
  lastStatus?: number
  updatedAt: number
}

export interface TestResult {
  name: string
  passed: boolean
  error?: string
}

export interface ScriptContext {
  environment: Record<string, string>
  variables: Record<string, string>
  request: {
    method: string
    url: string
    headers: KeyValue[]
    params: KeyValue[]
    body?: string
  }
  response?: {
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
    durationMs: number
    sizeBytes: number
    json?: unknown
  }
  dynamic: {
    timestamp: number
    uuid: string
    iso: string
  }
}

export interface EnvVariable {
  id: string
  key: string
  value: string
  enabled: boolean
  secret?: boolean
}

export interface Environment {
  id: string
  name: string
  variables: EnvVariable[]
  color?: string
}

export interface TagNode {
  id: string
  name: string
  parentId: string | null
  color: string
  sortOrder: number
  createdAt: number
}

export interface HistoryEntry {
  id: string
  ts: number
  kind: RequestKind
  method: HttpMethod
  url: string
  name: string
  status: number
  durationMs: number
  sizeBytes: number
  request: HttpRequestConfig
  tags: string[]
}

export interface ToolsSettings {
  followRedirects: boolean
  autoPrettify: boolean
  timeoutMs: number
  splitDirection: 'vertical' | 'horizontal'
  sidebarCollapsed: boolean
}

export interface Workspace {
  id: string
  name: string
  color: string
  sortOrder: number
  createdAt: number
}

export interface ApiTesterStateData {
  version: number
  nodes: CollectionNode[]
  environments: Environment[]
  globalVariables: EnvVariable[]
  tags: TagNode[]
  settings: ToolsSettings
  activeEnvId: string | null
}

export interface ApiTesterState extends ApiTesterStateData {
  workspaceId: string
  history: HistoryEntry[]
}

export interface ResponseTiming {
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  ttfbMs?: number
  downloadMs?: number
  totalMs: number
}

export interface ResponseResult {
  status: number
  statusText: string
  headers: Array<{ key: string; value: string }>
  contentType: string
  sizeBytes: number
  durationMs: number
  body: string
  bodyB64?: string | null
  redirected: boolean
  url: string
  error?: string
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
  timing?: ResponseTiming
}

export interface ApiTesterFile {
  id: string
  kind: FileKind
  name: string
  contentType: string
  size: number
  createdAt: number
  expiresAt: number
  url: string
}

export interface ProxyRequest {
  method: HttpMethod
  url: string
  headers: Array<{ key: string; value: string }>
  body?: string
  bodyFileId?: string
  redirect: 'follow' | 'manual'
  timeoutMs: number
}

export interface ProxyResponse {
  status: number
  statusText: string
  headers: Array<{ key: string; value: string }>
  contentType: string
  sizeBytes: number
  durationMs: number
  body: string | null
  bodyB64: string | null
  redirected: boolean
  url: string
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>
  timing: ResponseTiming
  error?: string
}

export interface OAuthTokenRequest {
  tokenUrl: string
  grantType?: 'authorization_code' | 'refresh_token'
  code?: string
  redirectUri?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
}

export interface OAuthTokenResponse {
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
  scope?: string
  error?: string
  errorDescription?: string
}

export interface WsTicketResponse {
  ticket: string
  url: string
}

export interface ApiTesterStateResponse {
  data: ApiTesterStateData
  rev: number
  updatedAt: number
}

export interface ApiTesterSaveResponse {
  rev: number
}
