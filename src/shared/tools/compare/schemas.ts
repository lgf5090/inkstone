/**
 * Zod schemas for `/api/tools/compare/*` — the shapes the routes accept, shared with the client so
 * the two cannot disagree about a field name.
 */
import { z } from 'zod'
import {
  ASSET_LIMITS,
  COMPARE_KINDS,
  DEFAULT_TEXT_OPTIONS,
  PROJECT_LIMITS,
  STATS_RANGES,
  normalizeTextOptions,
} from './types'

export const CompareKindSchema = z.enum(COMPARE_KINDS)

const LineRangeSchema = z
  .object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
  })
  .nullable()

export const TextCompareOptionsSchema = z
  .object({
    ignoreWhitespace: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    ignoreLineEndings: z.boolean().optional(),
    ignoreRegex: z.string().max(256).optional(),
    leftRange: LineRangeSchema.optional(),
    rightRange: LineRangeSchema.optional(),
  })
  .transform((value) => normalizeTextOptions(value))

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_LIMITS.name),
  kind: CompareKindSchema,
  left_label: z.string().max(PROJECT_LIMITS.label).optional().nullable(),
  right_label: z.string().max(PROJECT_LIMITS.label).optional().nullable(),
  options: TextCompareOptionsSchema.optional(),
  summary: z.record(z.string(), z.unknown()).optional().default({}),
  left_asset_id: z.string().min(1).max(64).optional().nullable(),
  right_asset_id: z.string().min(1).max(64).optional().nullable(),
})

export const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_LIMITS.name).optional(),
  options: TextCompareOptionsSchema.optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
})

export const ListProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PROJECT_LIMITS.listPage).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  kind: CompareKindSchema.optional(),
  search: z.string().max(80).optional(),
})

export const RunSchema = z.object({
  kind: CompareKindSchema,
  mode: z.enum(['side_by_side', 'inline', 'overlay', 'difference', 'slider', 'binary', 'dir']),
  left_name: z.string().max(255).optional().nullable(),
  right_name: z.string().max(255).optional().nullable(),
  left_ext: z.string().max(24).optional().nullable(),
  right_ext: z.string().max(24).optional().nullable(),
  added_lines: z.number().int().min(0).max(1_000_000).optional(),
  removed_lines: z.number().int().min(0).max(1_000_000).optional(),
  changed_blocks: z.number().int().min(0).max(1_000_000).optional(),
  identical: z.boolean().optional(),
  left_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  right_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
})

export const StatsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('7d'),
})

/** The upload form carries one of these buckets; the route turns it into an R2 folder. */
export const AssetKindSchema = CompareKindSchema

export const ASSET_MIME_BY_KIND: Readonly<Record<(typeof COMPARE_KINDS)[number], readonly string[]>> = {
  text: ['text/plain', 'text/markdown', 'text/x-patch', 'text/csv', 'text/html', 'application/json', 'application/xml'],
  file: ['text/plain', 'application/octet-stream', 'application/json', 'application/pdf', 'application/zip'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'],
  binary: ['application/octet-stream'],
  dir: ['application/json'],
}

/** Whether a declared type belongs in the bucket, or the bucket is one that accepts anything. */
export function mimeAllowed(kind: (typeof COMPARE_KINDS)[number], mime: string): boolean {
  if (kind === 'binary' || kind === 'file') return true
  const allowed = ASSET_MIME_BY_KIND[kind]
  return allowed.some((entry) => mime === entry || mime.startsWith(`${entry}/`))
}

export function assetLimit(kind: (typeof COMPARE_KINDS)[number]): number {
  return kind === 'image' ? ASSET_LIMITS.image : kind === 'dir' ? ASSET_LIMITS.dir : kind === 'binary' ? ASSET_LIMITS.binary : ASSET_LIMITS.text
}

/** The default a new project carries when nothing was chosen. */
export const PROJECT_DEFAULT_OPTIONS = DEFAULT_TEXT_OPTIONS
