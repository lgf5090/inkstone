/**
 * Shared Zod schemas for Short Links manager under Tools (`tools/shortlinks`).
 */

import { z } from 'zod'
import {
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  TIMELINE_RANGES,
} from './types'

export const CustomSlugRegex = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

export const CustomSlugSchema = z
  .string()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(CustomSlugRegex, 'Slug must contain only alphanumeric characters and hyphens, and cannot start or end with a hyphen')

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

export const VerifyPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(128),
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
  scope: z.enum(['read', 'read,write', 'admin']).default('read,write'),
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

export const ExportOptionsSchema = z.object({
  format: z.enum(['txt', 'csv', 'json', 'passwords']),
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
export type ExportOptionsInput = z.infer<typeof ExportOptionsSchema>
export type ImportDataInput = BatchImportInput
