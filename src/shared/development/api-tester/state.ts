import {
  API_TESTER_STATE_VERSION,
  HISTORY_LIMIT,
  MAX_ENVIRONMENTS,
  MAX_GLOBAL_VARIABLES,
  MAX_NODES,
  MAX_TAGS,
  MAX_TIMEOUT_MS,
  MAX_VARIABLES_PER_ENV,
  MIN_TIMEOUT_MS,
} from './limits'
import { DEFAULT_TAG_COLOR, DEFAULT_WORKSPACE_COLOR } from './keywords'
import { newApiTesterId } from './ids'
import type {
  ApiTesterState,
  ApiTesterStateData,
  AuthConfig,
  CollectionNode,
  EnvVariable,
  Environment,
  HistoryEntry,
  HttpRequestConfig,
  KeyValue,
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

function normalizeTag(raw: Partial<TagNode>): TagNode {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newApiTesterId(),
    name: typeof raw.name === 'string' ? raw.name : '',
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    color: typeof raw.color === 'string' && raw.color ? raw.color : DEFAULT_TAG_COLOR,
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : 0,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Math.floor(Date.now() / 1000),
  }
}

function normalizeVariable(raw: Partial<EnvVariable>): EnvVariable {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newApiTesterId(),
    key: typeof raw.key === 'string' ? raw.key : '',
    value: typeof raw.value === 'string' ? raw.value : '',
    enabled: raw.enabled !== false,
    secret: raw.secret === true ? true : undefined,
  }
}

function normalizeEnvironment(raw: Partial<Environment>): Environment {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newApiTesterId(),
    name: typeof raw.name === 'string' ? raw.name : '',
    color: typeof raw.color === 'string' ? raw.color : undefined,
    variables: Array.isArray(raw.variables)
      ? raw.variables.slice(0, MAX_VARIABLES_PER_ENV).map(normalizeVariable)
      : [],
  }
}

function normalizeNode(raw: Partial<CollectionNode>): CollectionNode | null {
  if (raw.type !== 'folder' && raw.type !== 'request') return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newApiTesterId()
  return {
    id,
    type: raw.type,
    name: typeof raw.name === 'string' ? raw.name : raw.type === 'folder' ? 'New folder' : 'New request',
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    order: typeof raw.order === 'number' ? raw.order : Date.now(),
    collapsed: raw.collapsed === true,
    kind: raw.kind === 'graphql' || raw.kind === 'websocket' ? raw.kind : 'rest',
    request: raw.request,
    ws: raw.ws,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    description: typeof raw.description === 'string' ? raw.description : undefined,
    preScript: typeof raw.preScript === 'string' ? raw.preScript : undefined,
    tests: typeof raw.tests === 'string' ? raw.tests : undefined,
    lastStatus: typeof raw.lastStatus === 'number' ? raw.lastStatus : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}

function normalizeHistory(raw: Partial<HistoryEntry>): HistoryEntry | null {
  if (typeof raw.id !== 'string' || !raw.id || !raw.request) return null
  return {
    id: raw.id,
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
    kind: raw.kind === 'graphql' || raw.kind === 'websocket' ? raw.kind : 'rest',
    method: raw.method ?? 'GET',
    url: typeof raw.url === 'string' ? raw.url : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    status: typeof raw.status === 'number' ? raw.status : 0,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
    request: raw.request,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }
}

export function normalizeState(raw: unknown, workspaceId: string): ApiTesterState {
  const source = (raw ?? {}) as Partial<ApiTesterState> & { settings?: Partial<ToolsSettings> }
  const nodes = Array.isArray(source.nodes)
    ? source.nodes
        .slice(0, MAX_NODES)
        .map((node) => normalizeNode(node as Partial<CollectionNode>))
        .filter((node): node is CollectionNode => node !== null)
    : []
  const tags = Array.isArray(source.tags)
    ? source.tags.slice(0, MAX_TAGS).map((tag) => normalizeTag(tag as Partial<TagNode>))
    : []
  const tagIds = new Set(tags.map((tag) => tag.id))
  for (const node of nodes) node.tags = node.tags.filter((tag) => tagIds.has(tag))
  const environments = Array.isArray(source.environments)
    ? source.environments
        .slice(0, MAX_ENVIRONMENTS)
        .map((environment) => normalizeEnvironment(environment as Partial<Environment>))
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
      ? source.globalVariables.slice(0, MAX_GLOBAL_VARIABLES).map((variable) => normalizeVariable(variable as Partial<EnvVariable>))
      : [],
    tags,
    history: Array.isArray(source.history)
      ? source.history
          .slice(0, HISTORY_LIMIT)
          .map((entry) => normalizeHistory(entry as Partial<HistoryEntry>))
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
    settings: state.settings,
    activeEnvId: state.activeEnvId,
  }
}
