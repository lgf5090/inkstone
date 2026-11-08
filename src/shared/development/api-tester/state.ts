import {
  API_TESTER_STATE_VERSION,
  HISTORY_LIMIT,
  MAX_DESCRIPTION_CHARS,
  MAX_ENVIRONMENTS,
  MAX_GLOBAL_VARIABLES,
  MAX_KV_ITEMS,
  MAX_KV_KEY_CHARS,
  MAX_KV_VALUE_CHARS,
  MAX_NAME_CHARS,
  MAX_NODES,
  MAX_SCRIPT_CHARS,
  MAX_TAG_DEPTH,
  MAX_TAG_NAME_CHARS,
  MAX_TAGS,
  MAX_TAGS_PER_NODE,
  MAX_TEXT_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MAX_TREE_DEPTH,
  MAX_URL_CHARS,
  MAX_VARIABLES_PER_ENV,
  MIN_TIMEOUT_MS,
} from './limits'
import { DEFAULT_TAG_COLOR, DEFAULT_WORKSPACE_COLOR } from './keywords'
import { newApiTesterId } from './ids'
import { HTTP_METHODS } from './types'
import type {
  ApiTesterState,
  ApiTesterStateData,
  AuthConfig,
  AuthType,
  BodyType,
  CollectionNode,
  CookieRecord,
  EnvVariable,
  Environment,
  HistoryEntry,
  HttpMethod,
  HttpRequestConfig,
  KeyValue,
  OAuth2Config,
  TagNode,
  ToolsSettings,
  WebSocketConfig,
  Workspace,
} from './types'

export function kv(key = '', value = '', enabled = true): KeyValue {
  return { id: newApiTesterId(), key, value, enabled }
}

export function emptyAuth(): AuthConfig {
  return {
    type: 'none',
    token: '',
    username: '',
    password: '',
    keyName: '',
    keyValue: '',
    oauth2: {
      authUrl: '',
      tokenUrl: '',
      clientId: '',
      clientSecret: '',
      scope: '',
      accessToken: '',
    },
  }
}

export function defaultSettings(): ToolsSettings {
  return {
    followRedirects: true,
    autoPrettify: true,
    timeoutMs: 30_000,
    splitDirection: 'vertical',
    sidebarCollapsed: false,
  }
}

export function defaultRequest(): HttpRequestConfig {
  return {
    method: 'GET',
    url: '',
    params: [],
    headers: [kv('Content-Type', 'application/json', false)],
    bodyType: 'none',
    body: '',
    formFields: [],
    auth: emptyAuth(),
    graphqlQuery: '',
    graphqlVariables: '{\n  \n}',
  }
}

export function defaultWs(): WebSocketConfig {
  return { url: '', headers: [] }
}

export function defaultState(workspaceId: string): ApiTesterState {
  return {
    workspaceId,
    version: API_TESTER_STATE_VERSION,
    nodes: [],
    environments: [],
    globalVariables: [],
    tags: [],
    cookies: [],
    history: [],
    settings: defaultSettings(),
    activeEnvId: null,
  }
}

export function defaultWorkspace(): Workspace {
  return {
    id: newApiTesterId(),
    name: 'Default workspace',
    color: DEFAULT_WORKSPACE_COLOR,
    sortOrder: 0,
    createdAt: Math.floor(Date.now() / 1000),
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

const BODY_TYPES: readonly BodyType[] = ['none', 'json', 'form-urlencoded', 'form-data', 'raw', 'binary']
const AUTH_TYPES: readonly AuthType[] = ['none', 'bearer', 'basic', 'apikey-header', 'apikey-query', 'oauth2']

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown, fallback = '', max?: number): string {
  const text = typeof value === 'string' ? value : fallback
  return max === undefined ? text : text.slice(0, max)
}

function asOptionalString(value: unknown, max?: number): string | undefined {
  return typeof value === 'string' ? (max === undefined ? value : value.slice(0, max)) : undefined
}

function normalizeKeyValue(raw: unknown, maxKey = MAX_KV_KEY_CHARS): KeyValue | null {
  const source = asRecord(raw)
  const key = asString(source.key, '', maxKey)
  const value = asString(source.value, '', MAX_KV_VALUE_CHARS)
  const id = typeof source.id === 'string' && source.id ? source.id : newApiTesterId()
  const fileId = typeof source.fileId === 'string' && source.fileId ? source.fileId : undefined
  if (!key && !value && !fileId) return { id, key: '', value: '', enabled: source.enabled !== false }
  return {
    id,
    key,
    value,
    enabled: source.enabled !== false,
    ...(source.isFile === true && fileId
      ? {
          isFile: true,
          fileId,
          fileName: asOptionalString(source.fileName, 200),
          fileSize: typeof source.fileSize === 'number' && Number.isFinite(source.fileSize) ? source.fileSize : undefined,
          fileType: asOptionalString(source.fileType, 200),
        }
      : {}),
  }
}

function normalizeKeyValueList(raw: unknown, max = MAX_KV_ITEMS): KeyValue[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, max).map((entry) => normalizeKeyValue(entry)).filter((entry): entry is KeyValue => entry !== null)
}

function normalizeOAuth2(raw: unknown): OAuth2Config {
  const source = asRecord(raw)
  return {
    authUrl: asString(source.authUrl, '', MAX_URL_CHARS),
    tokenUrl: asString(source.tokenUrl, '', MAX_URL_CHARS),
    clientId: asString(source.clientId, '', 2_048),
    clientSecret: asString(source.clientSecret, '', 4_096),
    scope: asString(source.scope, '', 2_048),
    accessToken: asString(source.accessToken, '', 16_384),
    refreshToken: asOptionalString(source.refreshToken, 16_384),
    tokenType: asOptionalString(source.tokenType, 128),
    expiresAt: typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt) ? source.expiresAt : undefined,
  }
}

function normalizeAuth(raw: unknown): AuthConfig {
  const source = asRecord(raw)
  const type = typeof source.type === 'string' && AUTH_TYPES.includes(source.type as AuthType)
    ? source.type as AuthType
    : 'none'
  return {
    type,
    token: asString(source.token, '', 16_384),
    username: asString(source.username, '', 4_096),
    password: asString(source.password, '', 4_096),
    keyName: asString(source.keyName, '', 200),
    keyValue: asString(source.keyValue, '', 8_192),
    oauth2: normalizeOAuth2(source.oauth2),
  }
}

export function normalizeRequest(raw: unknown): HttpRequestConfig {
  const source = asRecord(raw)
  const method = typeof source.method === 'string' && HTTP_METHODS.includes(source.method as HttpMethod)
    ? source.method as HttpMethod
    : 'GET'
  const bodyType = typeof source.bodyType === 'string' && BODY_TYPES.includes(source.bodyType as BodyType)
    ? source.bodyType as BodyType
    : 'none'
  return {
    method,
    url: asString(source.url, '', MAX_URL_CHARS),
    params: normalizeKeyValueList(source.params),
    headers: normalizeKeyValueList(source.headers),
    bodyType,
    body: asString(source.body, '', MAX_TEXT_BODY_BYTES),
    bodyFileId: typeof source.bodyFileId === 'string' && source.bodyFileId ? source.bodyFileId : undefined,
    bodyFileName: asOptionalString(source.bodyFileName, 200),
    bodyFileSize: typeof source.bodyFileSize === 'number' && Number.isFinite(source.bodyFileSize) ? source.bodyFileSize : undefined,
    formFields: normalizeKeyValueList(source.formFields),
    auth: normalizeAuth(source.auth),
    graphqlQuery: asString(source.graphqlQuery, '', MAX_SCRIPT_CHARS),
    graphqlVariables: asString(source.graphqlVariables, '{\n  \n}', MAX_SCRIPT_CHARS),
  }
}

function normalizeWs(raw: unknown): WebSocketConfig {
  const source = asRecord(raw)
  return {
    url: asString(source.url, '', MAX_URL_CHARS),
    headers: normalizeKeyValueList(source.headers),
  }
}

function normalizeTag(raw: unknown): TagNode {
  const source = asRecord(raw)
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newApiTesterId(),
    name: asString(source.name, '', MAX_TAG_NAME_CHARS),
    parentId: typeof source.parentId === 'string' ? source.parentId : null,
    color: typeof source.color === 'string' && source.color ? source.color : DEFAULT_TAG_COLOR,
    sortOrder: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : Math.floor(Date.now() / 1000),
  }
}

function normalizeVariable(raw: unknown): EnvVariable {
  const source = asRecord(raw)
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newApiTesterId(),
    key: asString(source.key, '', MAX_KV_KEY_CHARS),
    value: asString(source.value, '', MAX_KV_VALUE_CHARS),
    enabled: source.enabled !== false,
    secret: source.secret === true ? true : undefined,
  }
}

function normalizeEnvironment(raw: unknown): Environment {
  const source = asRecord(raw)
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newApiTesterId(),
    name: asString(source.name, '', MAX_NAME_CHARS),
    color: typeof source.color === 'string' ? source.color : undefined,
    variables: Array.isArray(source.variables)
      ? source.variables.slice(0, MAX_VARIABLES_PER_ENV).map(normalizeVariable)
      : [],
  }
}

function normalizeCookie(raw: unknown): CookieRecord | null {
  const source = asRecord(raw)
  const name = asString(source.name, '', 256)
  if (!name) return null
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newApiTesterId(),
    name,
    value: asString(source.value, '', MAX_KV_VALUE_CHARS),
    domain: asString(source.domain, '', 255).replace(/^\./, '').toLowerCase(),
    path: asString(source.path, '/', 512) || '/',
    expiresAt: typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt) ? source.expiresAt : undefined,
    secure: source.secure === true ? true : undefined,
    httpOnly: source.httpOnly === true ? true : undefined,
  }
}

function normalizeNode(raw: unknown): CollectionNode | null {
  const source = asRecord(raw)
  if (source.type !== 'folder' && source.type !== 'request') return null
  const type = source.type
  const kind = source.kind === 'graphql' || source.kind === 'websocket' ? source.kind : 'rest'
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newApiTesterId(),
    type,
    name: asString(source.name, type === 'folder' ? 'New folder' : 'New request', MAX_NAME_CHARS),
    parentId: typeof source.parentId === 'string' ? source.parentId : null,
    order: typeof source.order === 'number' ? source.order : Date.now(),
    collapsed: source.collapsed === true,
    kind: type === 'request' ? kind : undefined,
    request: type === 'request' && kind !== 'websocket' ? normalizeRequest(source.request) : undefined,
    ws: type === 'request' && kind === 'websocket' ? normalizeWs(source.ws) : undefined,
    tags: Array.isArray(source.tags)
      ? [...new Set(source.tags.filter((tag): tag is string => typeof tag === 'string'))].slice(0, MAX_TAGS_PER_NODE)
      : [],
    description: asOptionalString(source.description, MAX_DESCRIPTION_CHARS),
    preScript: asOptionalString(source.preScript, MAX_SCRIPT_CHARS),
    tests: asOptionalString(source.tests, MAX_SCRIPT_CHARS),
    lastStatus: typeof source.lastStatus === 'number' ? source.lastStatus : undefined,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : Date.now(),
  }
}

function normalizeHistory(raw: unknown): HistoryEntry | null {
  const source = asRecord(raw)
  if (typeof source.id !== 'string' || !source.id) return null
  return {
    id: source.id,
    ts: typeof source.ts === 'number' ? source.ts : Date.now(),
    kind: source.kind === 'graphql' || source.kind === 'websocket' ? source.kind : 'rest',
    method: typeof source.method === 'string' && HTTP_METHODS.includes(source.method as HttpMethod)
      ? source.method as HttpMethod
      : 'GET',
    url: asString(source.url, '', MAX_URL_CHARS),
    name: asString(source.name, '', MAX_NAME_CHARS),
    status: typeof source.status === 'number' ? source.status : 0,
    durationMs: typeof source.durationMs === 'number' ? source.durationMs : 0,
    sizeBytes: typeof source.sizeBytes === 'number' ? source.sizeBytes : 0,
    request: normalizeRequest(source.request),
    tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }
}

/**
 * Breaks parent cycles and over-deep chains in imported or older data.
 *
 * The renderers walk these edges recursively, so one cycle would otherwise hang the sidebar and
 * one very long chain would overflow the stack.
 */
function sanitizeTagParents(tags: TagNode[]): void {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  for (const tag of tags) {
    let current = tag
    let depth = 0
    const seen = new Set<string>([tag.id])
    while (current.parentId) {
      const parentId = current.parentId
      const parent = byId.get(parentId)
      if (!parent || seen.has(parentId) || depth >= MAX_TAG_DEPTH) {
        current.parentId = null
        break
      }
      seen.add(parentId)
      current = parent
      depth += 1
    }
  }
}

function sanitizeNodeParents(nodes: CollectionNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    let current = node
    let depth = 0
    const seen = new Set<string>([node.id])
    while (current.parentId) {
      const parentId = current.parentId
      const parent = byId.get(parentId)
      if (!parent || seen.has(parentId) || depth >= MAX_TREE_DEPTH) {
        current.parentId = null
        break
      }
      seen.add(parentId)
      current = parent
      depth += 1
    }
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function normalizeState(raw: unknown, workspaceId: string): ApiTesterState {
  const source = (raw ?? {}) as Partial<ApiTesterState> & { settings?: Partial<ToolsSettings> }
  const nodes = Array.isArray(source.nodes)
    ? dedupeById(
        source.nodes
          .slice(0, MAX_NODES)
          .map((node) => normalizeNode(node))
          .filter((node): node is CollectionNode => node !== null),
      )
    : []
  sanitizeNodeParents(nodes)
  const tags = Array.isArray(source.tags)
    ? dedupeById(source.tags.slice(0, MAX_TAGS).map((tag) => normalizeTag(tag)))
    : []
  sanitizeTagParents(tags)
  const tagIds = new Set(tags.map((tag) => tag.id))
  for (const node of nodes) node.tags = node.tags.filter((tag) => tagIds.has(tag))
  const environments = Array.isArray(source.environments)
    ? dedupeById(
        source.environments
          .slice(0, MAX_ENVIRONMENTS)
          .map((environment) => normalizeEnvironment(environment)),
      )
    : []
  const settings = { ...defaultSettings(), ...(source.settings ?? {}) }
  settings.timeoutMs = clampInt(settings.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 30_000)
  settings.splitDirection = settings.splitDirection === 'horizontal' ? 'horizontal' : 'vertical'
  settings.followRedirects = settings.followRedirects !== false
  settings.autoPrettify = settings.autoPrettify !== false
  settings.sidebarCollapsed = settings.sidebarCollapsed === true
  const activeEnvId =
    typeof source.activeEnvId === 'string' && environments.some((environment) => environment.id === source.activeEnvId)
      ? source.activeEnvId
      : null
  return {
    workspaceId,
    version: API_TESTER_STATE_VERSION,
    nodes,
    environments,
    globalVariables: Array.isArray(source.globalVariables)
      ? dedupeById(source.globalVariables.slice(0, MAX_GLOBAL_VARIABLES).map((variable) => normalizeVariable(variable)))
      : [],
    tags,
    cookies: Array.isArray(source.cookies)
      ? dedupeById(
          source.cookies
            .map((cookie) => normalizeCookie(cookie))
            .filter((cookie): cookie is CookieRecord => cookie !== null)
            .filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > Date.now()),
        )
      : [],
    history: Array.isArray(source.history)
      ? source.history
          .slice(0, HISTORY_LIMIT)
          .map((entry) => normalizeHistory(entry))
          .filter((entry): entry is HistoryEntry => entry !== null)
      : [],
    settings,
    activeEnvId,
  }
}

export function stateDataOf(state: ApiTesterState): ApiTesterStateData {
  return {
    version: state.version,
    nodes: state.nodes,
    environments: state.environments,
    globalVariables: state.globalVariables,
    tags: state.tags,
    cookies: state.cookies,
    settings: state.settings,
    activeEnvId: state.activeEnvId,
  }
}

/** Every uploaded file a saved workspace still points at, so deletion can clean the objects too. */
export function fileIdsOfState(data: Pick<ApiTesterStateData, 'nodes'>): string[] {
  const ids = new Set<string>()
  for (const node of data.nodes) {
    if (node.request?.bodyFileId) ids.add(node.request.bodyFileId)
    for (const field of node.request?.formFields ?? []) {
      if (field.isFile && field.fileId) ids.add(field.fileId)
    }
  }
  return [...ids]
}
