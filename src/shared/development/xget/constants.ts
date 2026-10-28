import type { XgetSettingsConfig } from './types'

export const XGET_PROXY_PREFIX = '/api/development/xget'

export const XGET_CONFIG_DEFAULTS: XgetSettingsConfig = {
  timeout_seconds: 30,
  max_retries: 3,
  retry_delay_ms: 1000,
  cache_duration: 300,
  allowed_methods: ['GET', 'HEAD'],
  allowed_origins: ['*'],
  max_path_length: 2048,
}

export const XGET_CONFIG_LIMITS = {
  timeoutSeconds: { min: 1, max: 120 },
  maxRetries: { min: 1, max: 10 },
  retryDelayMs: { min: 0, max: 30_000 },
  cacheDuration: { min: 1, max: 86_400 },
  maxPathLength: { min: 1, max: 8192 },
} as const

export const XGET_KNOWN_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export const XGET_TOKEN_MIN_LENGTH = 8
export const XGET_TOKEN_MAX_LENGTH = 128
export const XGET_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/

export const XGET_MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024
export const XGET_MAX_REWRITE_BYTES = 8 * 1024 * 1024

export const XGET_STATS_MAX_DAYS = 3650
export const XGET_HISTORY_LIMIT = 10
