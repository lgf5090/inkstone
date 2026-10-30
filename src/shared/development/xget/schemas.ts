import { z } from 'zod'
import { XGET_CONFIG_LIMITS } from './constants'

function boundedInteger(range: { readonly min: number; readonly max: number }) {
  return z.number().int().min(range.min).max(range.max)
}

export const XgetSettingsPatchSchema = z.object({
  timeout_seconds: boundedInteger(XGET_CONFIG_LIMITS.timeoutSeconds).optional(),
  max_retries: boundedInteger(XGET_CONFIG_LIMITS.maxRetries).optional(),
  retry_delay_ms: boundedInteger(XGET_CONFIG_LIMITS.retryDelayMs).optional(),
  cache_duration: boundedInteger(XGET_CONFIG_LIMITS.cacheDuration).optional(),
  allow_anonymous: z.boolean().optional(),
  allowed_methods: z.array(z.string()).max(16).optional(),
  allowed_origins: z.array(z.string()).max(64).optional(),
  max_path_length: boundedInteger(XGET_CONFIG_LIMITS.maxPathLength).optional(),
})

export const XgetTokenSchema = z.object({
  token: z.string().max(256),
})

export const XgetTestPathSchema = z.object({
  path: z.string().min(1).max(8192),
})

export type XgetSettingsPatch = z.infer<typeof XgetSettingsPatchSchema>
