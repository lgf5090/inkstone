import { z } from 'zod'

export const XgetSettingsPatchSchema = z.object({
  timeout_seconds: z.number().optional(),
  max_retries: z.number().optional(),
  retry_delay_ms: z.number().optional(),
  cache_duration: z.number().optional(),
  allow_anonymous: z.boolean().optional(),
  allowed_methods: z.array(z.string()).max(16).optional(),
  allowed_origins: z.array(z.string()).max(64).optional(),
  max_path_length: z.number().optional(),
})

export const XgetTokenSchema = z.object({
  token: z.string().max(256),
})

export const XgetTestPathSchema = z.object({
  path: z.string().min(1).max(8192),
})

export type XgetSettingsPatch = z.infer<typeof XgetSettingsPatchSchema>
