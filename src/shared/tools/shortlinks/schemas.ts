/**
 * Shared Zod schemas for Short Links manager under Tools (`tools/shortlinks`).
 */

import { z } from 'zod'
import {
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  TIMELINE_RANGES,
} from './types'

export const CustomSlugRegex = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const CustomSlugSchema = z
  .string()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(CustomSlugRegex, 'Slug must contain only lowercase letters, digits and hyphens, and cannot start or end with a hyphen')

export const CreateLinkSchema = z.object({
  url: z.string().url('Invalid URL format').max(2048, 'URL exceeds maximum length of 2048 characters'),
  label: z.string().max(256, 'Label exceeds 256 characters').optional().nullable(),
  password: z.string().min(1).max(64).optional().nullable(),
  slug_length: z.number().int().min(MIN_SLUG_LENGTH).max(MAX_SLUG_LENGTH).optional(),
  expires_at: z.number().int().nonnegative().optional().nullable(),
  allow_duplicate: z.boolean().optional(),
  custom_slug: CustomSlugSchema.optional().nullable(),
})

export const UpdateLinkSchema = z.object({
  url: z.string().url('Invalid URL format').max(2048).optional(),
  label: z.string().max(256).nullable().optional(),
  password: z.string().max(64).nullable().optional(),
  expires_at: z.number().int().nonnegative().nullable().optional(),
})

export const AddSlugSchema = z.object({
  slug: CustomSlugSchema,
})

export const SlugStatusSchema = z.object({
  is_active: z.boolean(),
})

export const CreateBundleSchema = z.object({
  name: z.string().trim().min(1, 'Bundle name is required').max(64, 'Bundle name exceeds 64 characters'),
  description: z.string().max(256).optional().nullable(),
  icon: z.string().max(64).optional().nullable(),
  accent: z.enum(['orange', 'red', 'green', 'blue', 'purple']).default('orange'),
})

export const UpdateBundleSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  accent: z.enum(['orange', 'red', 'green', 'blue', 'purple']).optional(),
})

export const AddBundleLinksSchema = z.object({
  link_ids: z.array(z.number().int().positive()).min(1, 'At least one link ID is required'),
})

export const UpdateSettingsSchema = z.object({
  slug_default_length: z.number().int().min(3).max(12).optional(),
  default_range: z.enum(TIMELINE_RANGES).optional(),
  filter_bots: z.boolean().optional(),
  filter_self_referrers: z.boolean().optional(),
})

export const CreateApiKeySchema = z.object({
  title: z.string().trim().min(1, 'API key title is required').max(64),
  scope: z.enum(['read', 'write', 'read,write', 'admin']).default('read,write'),
})

export const BatchImportSchema = z.object({
  items: z.array(
    z.object({
      url: z.string().url(),
      label: z.string().max(256).optional(),
      slug: CustomSlugSchema.optional(),
    }),
  ).min(1).max(500),
})

export const RestoreBackupSchema = z.object({
  backup_id: z.string().min(1, 'Backup id is required').max(200),
})

export const TimelineRangeSchema = z.enum(TIMELINE_RANGES)
export const LinkStatusSchema = z.enum(['all', 'active', 'disabled'])

/**
 * Query shape for `GET /links`. `range` stays optional: when absent the clicks column counts
 * every click ever recorded, which is what the list labels it as.
 */
export const ListLinksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  status: LinkStatusSchema.default('all'),
  sort_by: z.enum(['created_at', 'clicks']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().max(200).optional(),
  bundle_id: z.coerce.number().int().positive().optional(),
  range: TimelineRangeSchema.optional(),
})

export const BREAKDOWN_DIMENSIONS = [
  'country',
  'countries',
  'referrer',
  'referrers',
  'referrer_host',
  'referrer_hosts',
  'domain',
  'device_type',
  'devices',
  'os',
  'operating_system',
  'operating_systems',
  'browser',
  'browsers',
  'channel',
  'channels',
  'link_mode',
  'link_modes',
] as const

export const BreakdownQuerySchema = z.object({
  dimension: z.enum(BREAKDOWN_DIMENSIONS).default('country'),
  range: TimelineRangeSchema.default('30d'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  search: z.string().max(200).optional(),
})

export const AnalyticsRangeQuerySchema = z.object({
  range: TimelineRangeSchema.default('30d'),
})

export type CreateLinkInput = z.infer<typeof CreateLinkSchema>
export type UpdateLinkInput = z.infer<typeof UpdateLinkSchema>
export type AddSlugInput = z.infer<typeof AddSlugSchema>
export type CreateBundleInput = z.infer<typeof CreateBundleSchema>
export type UpdateBundleInput = z.infer<typeof UpdateBundleSchema>
export type AddBundleLinksInput = z.infer<typeof AddBundleLinksSchema>
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>
export type BatchImportInput = z.infer<typeof BatchImportSchema>
export type ImportDataInput = BatchImportInput
export type ListLinksQuery = z.infer<typeof ListLinksQuerySchema>
export type BreakdownQuery = z.infer<typeof BreakdownQuerySchema>
export type AnalyticsRangeQuery = z.infer<typeof AnalyticsRangeQuerySchema>
