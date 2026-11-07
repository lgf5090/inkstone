import type {
  WebsshEgressConfig,
  WebsshEgressMode,
  WebsshEgressProxyConfig,
  WebsshEgressResolvedRegion,
  WebsshEgressSettingsView,
  WebsshHostEgress,
  WebsshRegionHint,
} from '@shared/webssh/types'
import { WEBSSH_REGION_HINTS, WEBSSH_REGION_HINTS_NEARBY } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'

export const WEBSSH_DEFAULT_REGION_CANDIDATES: readonly WebsshRegionHint[] = ['apac', 'weur', 'enam', 'wnam']
export const WEBSSH_MAX_REGION_CANDIDATES = 6
export const WEBSSH_MAX_PROXY_ALLOWLIST = 100
export const WEBSSH_PROXY_ALLOWLIST_ENTRY_MAX = 253

const REGION_SET = new Set<string>([...WEBSSH_REGION_HINTS, ...WEBSSH_REGION_HINTS_NEARBY])
const MODE_SET = new Set<string>(['direct', 'jump', 'socks5', 'http-connect'])
const PROXY_AUTH_SET = new Set<string>(['none', 'password'])

export interface WebsshEgressSettings {
  defaultMode: WebsshEgressMode
  defaultRegion: 'auto' | WebsshRegionHint
  regionCandidates: WebsshRegionHint[]
  fallbackEnabled: boolean
  proxyAllowlist: string[]
}

export interface WebsshEgressPlan {
  mode: WebsshEgressMode
  available: boolean
  /** Relay modes are reserved until a relay node exists. */
  unavailableReason: 'relay_requires_node' | null
  region: 'auto' | WebsshRegionHint
  regionHint: WebsshRegionHint
  regionSource: 'host' | 'global' | 'resolved' | 'auto' | 'request'
  regionCandidates: WebsshRegionHint[]
  regionFailoverAllowed: boolean
  regionResolved: WebsshEgressResolvedRegion | null
  fallbackEnabled: boolean
  fallbackMode: '' | WebsshEgressMode
  jumpHostId: string
  proxy: WebsshEgressProxyConfig
}

export function isWebsshRegionHint(value: unknown): value is WebsshRegionHint {
  return typeof value === 'string' && REGION_SET.has(value)
}

export function isRelayMode(mode: WebsshEgressMode): boolean {
  return mode !== 'direct'
}

export function defaultProxyConfig(): WebsshEgressProxyConfig {
  return { host: '', port: 0, auth: 'none', username: '', credentialId: '' }
}

export function defaultHostEgress(): WebsshHostEgress {
  return {
    mode: '',
    region: '',
    jumpHostId: '',
    proxy: defaultProxyConfig(),
    fallback: { enabled: null, mode: '' },
    regionResolved: null,
  }
}

export function defaultEgressSettings(): WebsshEgressSettings {
  return {
    defaultMode: 'direct',
    defaultRegion: 'auto',
    regionCandidates: [...WEBSSH_DEFAULT_REGION_CANDIDATES],
    fallbackEnabled: false,
    proxyAllowlist: [],
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseMode(value: unknown): '' | WebsshEgressMode {
  return typeof value === 'string' && MODE_SET.has(value) ? value as WebsshEgressMode : ''
}

function parseProxy(value: unknown): WebsshEgressProxyConfig {
  const record = asRecord(value)
  if (!record) return defaultProxyConfig()
  const host = typeof record.host === 'string' ? record.host.trim().slice(0, 255) : ''
  const port = typeof record.port === 'number' && Number.isInteger(record.port) && record.port >= 0 && record.port <= 65535
    ? record.port
    : 0
  const auth = typeof record.auth === 'string' && PROXY_AUTH_SET.has(record.auth) ? record.auth as 'none' | 'password' : 'none'
  const username = typeof record.username === 'string' ? record.username.trim().slice(0, 255) : ''
  const credentialId = typeof record.credentialId === 'string' && isValidId(record.credentialId) ? record.credentialId : ''
  return { host, port, auth, username, credentialId }
}

function parseResolvedRegion(value: unknown): WebsshEgressResolvedRegion | null {
  const record = asRecord(value)
  if (!record || !isWebsshRegionHint(record.region)) return null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? Math.trunc(record.at) : 0
  const failures = typeof record.failures === 'number' && Number.isFinite(record.failures)
    ? Math.max(0, Math.trunc(record.failures))
    : 0
  return { region: record.region, at, failures }
}

/** Tolerant read: a hand-edited or older row keeps whatever fields still make sense. */
export function parseHostEgress(raw: string | null | undefined): WebsshHostEgress {
  const base = defaultHostEgress()
  if (!raw) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  const record = asRecord(parsed)
  if (!record) return base
  const fallback = asRecord(record.fallback)
  const region = record.region === 'auto' || isWebsshRegionHint(record.region) ? record.region : ''
  return {
    mode: parseMode(record.mode),
    region,
    jumpHostId: typeof record.jumpHostId === 'string' && isValidId(record.jumpHostId) ? record.jumpHostId : '',
    proxy: parseProxy(record.proxy),
    fallback: {
      enabled: typeof fallback?.enabled === 'boolean' ? fallback.enabled : null,
      mode: parseMode(fallback?.mode),
    },
    regionResolved: parseResolvedRegion(record.regionResolved),
  }
}

export function parseEgressSettings(value: unknown): WebsshEgressSettings {
  const base = defaultEgressSettings()
  const record = asRecord(value)
  if (!record) return base
  const candidates = Array.isArray(record.regionCandidates)
    ? record.regionCandidates.filter(isWebsshRegionHint)
    : base.regionCandidates
  const uniqueCandidates = [...new Set(candidates)].slice(0, WEBSSH_MAX_REGION_CANDIDATES)
  const allowlist = Array.isArray(record.proxyAllowlist)
    ? record.proxyAllowlist.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, WEBSSH_MAX_PROXY_ALLOWLIST)
    : base.proxyAllowlist
  return {
    defaultMode: parseMode(record.defaultMode) || base.defaultMode,
    defaultRegion: record.defaultRegion === 'auto' || isWebsshRegionHint(record.defaultRegion)
      ? record.defaultRegion
      : base.defaultRegion,
    regionCandidates: uniqueCandidates.length ? uniqueCandidates : base.regionCandidates,
    fallbackEnabled: record.fallbackEnabled === true,
    proxyAllowlist: allowlist,
  }
}

function normalizeProxyInput(value: unknown, fallback: WebsshEgressProxyConfig): WebsshEgressProxyConfig {
  if (value === undefined || value === null) return fallback
  const record = asRecord(value)
  if (!record) throw ApiError.badRequest('egress.proxy must be an object')
  const host = typeof record.host === 'string' ? record.host.trim() : fallback.host
  if (host.length > 255) throw ApiError.badRequest('The proxy host cannot exceed 255 characters')
  if (/[\0\r\n]/.test(host)) throw ApiError.badRequest('The proxy host cannot contain control characters')
  const portValue = record.port === undefined || record.port === null || record.port === '' ? fallback.port : Number(record.port)
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) {
    throw ApiError.badRequest('The proxy port must be an integer between 1 and 65535')
  }
  const auth = record.auth === undefined || record.auth === null ? fallback.auth : record.auth
  if (auth !== 'none' && auth !== 'password') throw ApiError.badRequest('The proxy auth method must be none or password')
  const username = record.username === undefined || record.username === null ? fallback.username : String(record.username).trim()
  if (username.length > 255) throw ApiError.badRequest('The proxy username cannot exceed 255 characters')
  const credentialId = record.credentialId === undefined || record.credentialId === null
    ? fallback.credentialId
    : String(record.credentialId)
  if (credentialId && !isValidId(credentialId)) throw ApiError.badRequest('The proxy credential id is invalid')
  if (auth === 'password' && (!username || !credentialId)) {
    throw ApiError.badRequest('Proxy password authentication needs a username and a credential')
  }
  return { host, port: portValue, auth, username, credentialId }
}

/** Validates the browser's host-level egress draft and fills omitted fields from the saved row. */
export function normalizeHostEgressInput(value: unknown, fallback: WebsshHostEgress = defaultHostEgress()): WebsshEgressConfig {
  if (value === undefined || value === null) {
    return {
      mode: fallback.mode,
      region: fallback.region,
      jumpHostId: fallback.jumpHostId,
      proxy: fallback.proxy,
      fallback: fallback.fallback,
    }
  }
  const record = asRecord(value)
  if (!record) throw ApiError.badRequest('egress must be an object')
  const mode = record.mode === undefined || record.mode === null
    ? fallback.mode
    : record.mode
  if (mode !== '' && !MODE_SET.has(String(mode))) throw ApiError.badRequest('egress.mode is not supported')
  const region = record.region === undefined || record.region === null
    ? fallback.region
    : record.region
  if (region !== '' && region !== 'auto' && !isWebsshRegionHint(region)) {
    throw ApiError.badRequest('egress.region must be auto or a supported region hint')
  }
  const jumpHostId = record.jumpHostId === undefined || record.jumpHostId === null
    ? fallback.jumpHostId
    : String(record.jumpHostId)
  if (jumpHostId && !isValidId(jumpHostId)) throw ApiError.badRequest('egress.jumpHostId is invalid')
  const proxy = normalizeProxyInput(record.proxy, fallback.proxy)
  const fallbackRecord = asRecord(record.fallback)
  const fallbackEnabled = fallbackRecord?.enabled === undefined
    ? fallback.fallback.enabled
    : fallbackRecord.enabled
  if (fallbackEnabled !== null && typeof fallbackEnabled !== 'boolean') {
    throw ApiError.badRequest('egress.fallback.enabled must be true, false or null')
  }
  const fallbackMode = fallbackRecord?.mode === undefined || fallbackRecord.mode === null
    ? fallback.fallback.mode
    : fallbackRecord.mode
  if (fallbackMode !== '' && !MODE_SET.has(String(fallbackMode))) {
    throw ApiError.badRequest('egress.fallback.mode is not supported')
  }
  if ((mode === 'socks5' || mode === 'http-connect') && (!proxy.host || !proxy.port)) {
    throw ApiError.badRequest('A proxy host and port are required for this egress mode')
  }
  return {
    mode: mode as '' | WebsshEgressMode,
    region: region as '' | 'auto' | WebsshRegionHint,
    jumpHostId,
    proxy,
    fallback: { enabled: fallbackEnabled as boolean | null, mode: fallbackMode as '' | WebsshEgressMode },
  }
}

/** Settings writes stay on the direct path until a relay node exists. */
export function normalizeEgressSettingsInput(value: unknown, current: WebsshEgressSettings): WebsshEgressSettings {
  const record = asRecord(value)
  if (!record) throw ApiError.badRequest('egress settings must be an object')
  const next: WebsshEgressSettings = { ...current, regionCandidates: [...current.regionCandidates], proxyAllowlist: [...current.proxyAllowlist] }
  if (record.defaultMode !== undefined) {
    if (record.defaultMode !== 'direct') {
      throw new ApiError(400, 'egress_mode_unavailable', 'Relay egress modes need a relay node and are not available yet')
    }
    next.defaultMode = 'direct'
  }
  if (record.defaultRegion !== undefined) {
    if (record.defaultRegion !== 'auto' && !isWebsshRegionHint(record.defaultRegion)) {
      throw ApiError.badRequest('defaultRegion must be auto or a supported region hint')
    }
    next.defaultRegion = record.defaultRegion
  }
  if (record.regionCandidates !== undefined) {
    if (!Array.isArray(record.regionCandidates)) throw ApiError.badRequest('regionCandidates must be an array')
    const candidates = record.regionCandidates.filter(isWebsshRegionHint)
    if (candidates.length !== record.regionCandidates.length) throw ApiError.badRequest('regionCandidates contains an unsupported hint')
    const unique = [...new Set(candidates)]
    if (unique.length === 0) throw ApiError.badRequest('Choose at least one region candidate')
    next.regionCandidates = unique.slice(0, WEBSSH_MAX_REGION_CANDIDATES)
  }
  if (record.fallbackEnabled !== undefined) {
    if (typeof record.fallbackEnabled !== 'boolean') throw ApiError.badRequest('fallbackEnabled must be a boolean')
    next.fallbackEnabled = record.fallbackEnabled
  }
  if (record.proxyAllowlist !== undefined) {
    if (!Array.isArray(record.proxyAllowlist)) throw ApiError.badRequest('proxyAllowlist must be an array')
    const entries = record.proxyAllowlist
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (entries.length > WEBSSH_MAX_PROXY_ALLOWLIST) throw ApiError.badRequest('The proxy allowlist is too long')
    for (const entry of entries) {
      if (entry.length > WEBSSH_PROXY_ALLOWLIST_ENTRY_MAX || /[\0\r\n]/.test(entry)) {
        throw ApiError.badRequest('A proxy allowlist entry is invalid')
      }
    }
    next.proxyAllowlist = [...new Set(entries)]
  }
  return next
}

function regionCandidates(primary: WebsshRegionHint, resolved: WebsshRegionHint | null, settings: WebsshEgressSettings): WebsshRegionHint[] {
  const ordered = [
    primary,
    ...(resolved ? [resolved] : []),
    ...settings.regionCandidates,
  ]
  const unique = [...new Set(ordered)]
  const filled = unique.length ? unique : [...WEBSSH_DEFAULT_REGION_CANDIDATES]
  return filled.slice(0, WEBSSH_MAX_REGION_CANDIDATES)
}

export interface ResolveEgressPlanOptions {
  /** A client-selected hint, or a hint selected by a previous region failover. */
  regionOverride?: string
  /** Set when this session is the single region retry, which must not fail over again. */
  retryFrom?: string
}

export function resolveEgressPlan(
  host: WebsshHostEgress,
  settings: WebsshEgressSettings,
  options: ResolveEgressPlanOptions = {},
): WebsshEgressPlan {
  const configuredMode = host.mode || settings.defaultMode
  const available = !isRelayMode(configuredMode)
  const hostRegion = host.region
  const globalRegion = settings.defaultRegion
  let configuredRegion: 'auto' | WebsshRegionHint
  let regionSource: WebsshEgressPlan['regionSource']
  if (hostRegion === 'auto' || (hostRegion === '' && globalRegion === 'auto')) {
    configuredRegion = 'auto'
    regionSource = 'auto'
  } else if (hostRegion) {
    configuredRegion = hostRegion
    regionSource = 'host'
  } else if (globalRegion !== 'auto') {
    configuredRegion = globalRegion
    regionSource = 'global'
  } else {
    configuredRegion = 'auto'
    regionSource = 'auto'
  }

  let regionHint: WebsshRegionHint
  let regionFailoverAllowed = false
  if (options.regionOverride && isWebsshRegionHint(options.regionOverride)) {
    configuredRegion = options.regionOverride
    regionHint = options.regionOverride
    regionSource = 'request'
  } else if (configuredRegion !== 'auto') {
    regionHint = configuredRegion
  } else {
    const resolved = host.regionResolved
    if (resolved && resolved.failures < 2) {
      regionHint = resolved.region
      if (regionSource === 'auto') regionSource = 'resolved'
    } else {
      regionHint = settings.regionCandidates[0] ?? WEBSSH_DEFAULT_REGION_CANDIDATES[0]
    }
    regionFailoverAllowed = !options.retryFrom
  }

  return {
    mode: configuredMode,
    available,
    unavailableReason: available ? null : 'relay_requires_node',
    region: configuredRegion,
    regionHint,
    regionSource,
    regionCandidates: regionCandidates(regionHint, host.regionResolved?.region ?? null, settings),
    regionFailoverAllowed,
    regionResolved: host.regionResolved,
    fallbackEnabled: host.fallback.enabled ?? settings.fallbackEnabled,
    fallbackMode: host.fallback.mode,
    jumpHostId: host.jumpHostId,
    proxy: host.proxy,
  }
}

/** The next hint to try after a retryable failure, or null when one retry is not allowed. */
export function nextRegionCandidate(plan: WebsshEgressPlan, failedRegion: string): WebsshRegionHint | null {
  if (!plan.regionFailoverAllowed) return null
  const index = plan.regionCandidates.indexOf(failedRegion as WebsshRegionHint)
  if (index >= 0) {
    const next = plan.regionCandidates[index + 1]
    return next && next !== failedRegion ? next : null
  }
  return plan.regionCandidates.find((candidate) => candidate !== failedRegion) ?? null
}

export function websshEgressSettingsView(settings: WebsshEgressSettings): WebsshEgressSettingsView {
  return {
    defaultMode: settings.defaultMode,
    defaultRegion: settings.defaultRegion,
    regionCandidates: settings.regionCandidates,
    fallbackEnabled: settings.fallbackEnabled,
    proxyAllowlist: settings.proxyAllowlist,
    relayModesAvailable: false,
  }
}
