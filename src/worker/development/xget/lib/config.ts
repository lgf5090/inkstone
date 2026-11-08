// Derived from Xget (AGPL-3.0-only) src/config/index.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_PLATFORMS } from '@shared/development/xget/catalog'
import { readMethods, readOrigins } from '@shared/development/xget/config-values'
import {
  XGET_CONFIG_DEFAULTS,
  XGET_CONFIG_LIMITS,
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
  ALLOW_ANONYMOUS: boolean
  RATE_LIMIT_PER_MINUTE: number
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
  const methods = readMethods(value).methods
  return methods.length ? methods : [...XGET_CONFIG_DEFAULTS.allowed_methods]
}

function normalizeOrigins(value: unknown): string[] {
  if (value === undefined) {
    return [...XGET_CONFIG_DEFAULTS.allowed_origins]
  }
  return readOrigins(value).origins
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
    ALLOW_ANONYMOUS:
      typeof overrides.ALLOW_ANONYMOUS === 'boolean'
        ? overrides.ALLOW_ANONYMOUS
        : defaults.allow_anonymous,
    RATE_LIMIT_PER_MINUTE: parseBoundedInteger(
      overrides.RATE_LIMIT_PER_MINUTE,
      defaults.rate_limit_per_minute,
      XGET_CONFIG_LIMITS.rateLimitPerMinute.min,
      XGET_CONFIG_LIMITS.rateLimitPerMinute.max,
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
