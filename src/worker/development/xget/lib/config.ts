// Derived from Xget (AGPL-3.0-only) src/config/index.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_PLATFORMS } from '@shared/development/xget/catalog'
import {
  XGET_CONFIG_DEFAULTS,
  XGET_CONFIG_LIMITS,
  XGET_KNOWN_METHODS,
} from '@shared/development/xget/constants'
import type { XgetConfigOverrides } from '@shared/development/xget/types'

export type { XgetConfigOverrides }

export interface SecurityConfig {
  ALLOWED_METHODS: string[]
  ALLOWED_ORIGINS: string[]
  MAX_PATH_LENGTH: number
}

export interface XgetConfig {
  TIMEOUT_SECONDS: number
  MAX_RETRIES: number
  RETRY_DELAY_MS: number
  CACHE_DURATION: number
  SECURITY: SecurityConfig
  PLATFORMS: Record<string, string>
}

const PLATFORMS: Record<string, string> = Object.fromEntries(
  XGET_PLATFORMS.map((platform) => [platform.key, platform.upstreamBase] as const),
)

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback
  }
  return parsed
}

function normalizeMethods(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...XGET_CONFIG_DEFAULTS.allowed_methods]
  }

  const methods: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const method = entry.trim().toUpperCase()
    if (!(XGET_KNOWN_METHODS as readonly string[]).includes(method)) continue
    if (methods.includes(method)) continue
    methods.push(method)
  }

  return methods.length ? methods : [...XGET_CONFIG_DEFAULTS.allowed_methods]
}

function normalizeOrigin(value: string): string | null {
  if (value === '*') return '*'

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null

  return parsed.origin
}

function normalizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...XGET_CONFIG_DEFAULTS.allowed_origins]
  }

  const origins: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const origin = normalizeOrigin(entry.trim())
    if (!origin || origins.includes(origin)) continue
    origins.push(origin)
  }

  if (origins.includes('*')) return ['*']
  return origins.length ? origins : [...XGET_CONFIG_DEFAULTS.allowed_origins]
}

export function createConfig(overrides: XgetConfigOverrides = {}): XgetConfig {
  const defaults = XGET_CONFIG_DEFAULTS

  return {
    TIMEOUT_SECONDS: parseBoundedInteger(
      overrides.TIMEOUT_SECONDS,
      defaults.timeout_seconds,
      XGET_CONFIG_LIMITS.timeoutSeconds.min,
      XGET_CONFIG_LIMITS.timeoutSeconds.max,
    ),
    MAX_RETRIES: parseBoundedInteger(
      overrides.MAX_RETRIES,
      defaults.max_retries,
      XGET_CONFIG_LIMITS.maxRetries.min,
      XGET_CONFIG_LIMITS.maxRetries.max,
    ),
    RETRY_DELAY_MS: parseBoundedInteger(
      overrides.RETRY_DELAY_MS,
      defaults.retry_delay_ms,
      XGET_CONFIG_LIMITS.retryDelayMs.min,
      XGET_CONFIG_LIMITS.retryDelayMs.max,
    ),
    CACHE_DURATION: parseBoundedInteger(
      overrides.CACHE_DURATION,
      defaults.cache_duration,
      XGET_CONFIG_LIMITS.cacheDuration.min,
      XGET_CONFIG_LIMITS.cacheDuration.max,
    ),
    SECURITY: {
      ALLOWED_METHODS: normalizeMethods(overrides.SECURITY?.ALLOWED_METHODS),
      ALLOWED_ORIGINS: normalizeOrigins(overrides.SECURITY?.ALLOWED_ORIGINS),
      MAX_PATH_LENGTH: parseBoundedInteger(
        overrides.SECURITY?.MAX_PATH_LENGTH,
        defaults.max_path_length,
        XGET_CONFIG_LIMITS.maxPathLength.min,
        XGET_CONFIG_LIMITS.maxPathLength.max,
      ),
    },
    PLATFORMS: { ...PLATFORMS },
  }
}
