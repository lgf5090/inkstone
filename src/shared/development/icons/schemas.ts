import { z } from 'zod'
import {
  ICON_BATCH_ACTIONS,
  ICON_COLLECTION_NAME_MAX,
  ICON_CURSOR_MAX_LENGTH,
  ICON_EXPORT_FORMATS,
  ICON_ICO_PRESETS,
  ICON_ICONIFY_PREFIXES,
  ICON_IMPORT_KINDS,
  ICON_KEYWORDS_MAX,
  ICON_MAX_BATCH_IDS,
  ICON_MAX_TAG_IDS,
  ICON_PAGE_SIZE_DEFAULT,
  ICON_PAGE_SIZE_MAX,
  ICON_PNG_PRESETS,
  ICON_SEARCH_MAX_LENGTH,
  ICON_SMART_VIEWS,
  ICON_SORTS,
  ICON_SPRITE_PADDING_DEFAULT,
  ICON_SPRITE_PADDING_MAX,
  ICON_SPRITE_SCALES,
  ICON_TAG_NAME_MAX,
  ICON_USAGE_ACTIONS,
  ICON_FORMATS,
} from './limits'

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const Id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)
const Slug = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const KeywordText = z.string().max(ICON_KEYWORDS_MAX)
const HttpUrl = z.string().max(2048).refine((value) => value === '' || /^https?:\/\//i.test(value), 'URL must use http or https')

const PngSize = z.union(ICON_PNG_PRESETS.map((size) => z.literal(size)) as [
  z.ZodLiteral<24>,
  z.ZodLiteral<48>,
  z.ZodLiteral<96>,
  z.ZodLiteral<192>,
  z.ZodLiteral<512>,
])

const IcoSize = z.union(ICON_ICO_PRESETS.map((size) => z.literal(size)) as [
  z.ZodLiteral<16>,
  z.ZodLiteral<32>,
  z.ZodLiteral<48>,
  z.ZodLiteral<256>,
])

const SpriteScale = z.union([z.literal(1), z.literal(2)])

export const IconCursorPayloadSchema = z.object({
  sort: z.enum(ICON_SORTS),
  key: z.union([z.string().max(512), z.number().finite()]),
  id: Id,
})

export const IconCollectionInputSchema = z.object({
  name: z.string().trim().min(1).max(ICON_COLLECTION_NAME_MAX),
  description: z.string().max(2000).default(''),
  source: z.enum(['upload', 'iconify', 'local']).default('upload'),
  license: z.string().max(200).default(''),
  homepage: HttpUrl.default(''),
  sortOrder: z.number().int().min(0).max(100000).default(0),
})

export const IconCollectionPatchSchema = z.object({
  name: z.string().trim().min(1).max(ICON_COLLECTION_NAME_MAX).optional(),
  description: z.string().max(2000).optional(),
  license: z.string().max(200).optional(),
  homepage: HttpUrl.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

export const IconTagInputSchema = z.object({
  name: z.string().trim().min(1).max(ICON_TAG_NAME_MAX),
  color: HexColor.default('#64748b'),
  parentId: Id.nullable().default(null),
  sortOrder: z.number().int().min(0).max(100000).default(0),
})

export const IconTagPatchSchema = z.object({
  name: z.string().trim().min(1).max(ICON_TAG_NAME_MAX).optional(),
  color: HexColor.optional(),
  parentId: Id.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

export const IconAssetPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  collectionId: Id.nullable().optional(),
  keywords: KeywordText.optional(),
  tagIds: z.array(Id).max(ICON_MAX_TAG_IDS).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

const IconBatchBase = {
  ids: z.array(Id).min(1).max(ICON_MAX_BATCH_IDS),
}

export const IconBatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), ...IconBatchBase }),
  z.object({ action: z.literal('move'), ...IconBatchBase, collectionId: Id.nullable() }),
  z.object({ action: z.literal('tag'), ...IconBatchBase, tagIds: z.array(Id).max(ICON_MAX_TAG_IDS) }),
  z.object({ action: z.literal('favorite'), ...IconBatchBase }),
  z.object({ action: z.literal('unfavorite'), ...IconBatchBase }),
  z.object({ action: z.literal('pin'), ...IconBatchBase }),
  z.object({ action: z.literal('unpin'), ...IconBatchBase }),
])

const IdCsv = z
  .string()
  .max(2400)
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .refine((values) => values.length <= 20 && values.every((value) => Id.safeParse(value).success), 'Invalid id list')

const FormatCsv = z
  .string()
  .max(64)
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .refine((values) => values.length <= ICON_FORMATS.length && values.every((value) => (ICON_FORMATS as readonly string[]).includes(value)), 'Invalid format list')

export const IconListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ICON_PAGE_SIZE_MAX).default(ICON_PAGE_SIZE_DEFAULT),
  cursor: z.string().max(ICON_CURSOR_MAX_LENGTH).optional(),
  q: z.string().max(ICON_SEARCH_MAX_LENGTH).optional(),
  collectionId: Id.optional(),
  collections: IdCsv.optional(),
  tagId: Id.optional(),
  tags: IdCsv.optional(),
  format: z.enum(ICON_FORMATS).optional(),
  formats: FormatCsv.optional(),
  style: z.enum(['line', 'fill', 'duotone', 'brand']).optional(),
  colorMode: z.enum(['mono', 'multi']).optional(),
  sizeMin: z.coerce.number().int().min(0).max(8192).optional(),
  sizeMax: z.coerce.number().int().min(0).max(8192).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  state: z.enum(ICON_SMART_VIEWS).default('all'),
  sort: z.enum(ICON_SORTS).default('created'),
})

export const IconUsageSchema = z.object({
  action: z.enum(ICON_USAGE_ACTIONS),
})

export const IconSettingsPatchSchema = z.object({
  quotaBytes: z.number().int().min(1).optional(),
  maxSvgBytes: z.number().int().min(1).optional(),
  maxRasterBytes: z.number().int().min(1).optional(),
  maxDimension: z.number().int().min(1).optional(),
  batchLimit: z.number().int().min(1).optional(),
  zipLimitBytes: z.number().int().min(1).optional(),
  zipLimitEntries: z.number().int().min(1).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

export const IconLimitsPatchSchema = z.object({
  hardQuotaBytes: z.number().int().min(1).optional(),
  hardMaxSvgBytes: z.number().int().min(1).optional(),
  hardMaxRasterBytes: z.number().int().min(1).optional(),
  hardMaxDimension: z.number().int().min(1).optional(),
  hardBatchLimit: z.number().int().min(1).optional(),
  hardZipLimitBytes: z.number().int().min(1).optional(),
  hardZipLimitEntries: z.number().int().min(1).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')

const IconJobOptionsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('png'),
    sizes: z.array(PngSize).min(1).max(ICON_PNG_PRESETS.length).default([...ICON_PNG_PRESETS]),
  }),
  z.object({
    kind: z.literal('ico'),
    sizes: z.array(IcoSize).min(1).max(ICON_ICO_PRESETS.length).default([...ICON_ICO_PRESETS]),
  }),
  z.object({
    kind: z.literal('sprite_svg'),
    padding: z.number().int().min(0).max(ICON_SPRITE_PADDING_MAX).default(ICON_SPRITE_PADDING_DEFAULT),
  }),
  z.object({
    kind: z.literal('sprite_png'),
    padding: z.number().int().min(0).max(ICON_SPRITE_PADDING_MAX).default(ICON_SPRITE_PADDING_DEFAULT),
    scales: z.array(SpriteScale).min(1).max(ICON_SPRITE_SCALES.length).default([1]),
    scss: z.boolean().default(false),
  }),
]).superRefine((value, context) => {
  if ('sizes' in value && new Set(value.sizes).size !== value.sizes.length) {
    context.addIssue({ code: 'custom', path: ['sizes'], message: 'Sizes must be unique' })
  }
  if ('scales' in value && new Set(value.scales).size !== value.scales.length) {
    context.addIssue({ code: 'custom', path: ['scales'], message: 'Scales must be unique' })
  }
})

export const IconJobCreateSchema = z.object({
  assetIds: z.array(Id).min(1).max(500),
  options: IconJobOptionsSchema,
})

export const IconExportCreateSchema = z.object({
  format: z.enum(ICON_EXPORT_FORMATS),
  assetIds: z.array(Id).min(1).max(500),
  options: IconJobOptionsSchema.optional(),
})

export const IconImportCreateSchema = z.object({
  kind: z.enum(ICON_IMPORT_KINDS),
  prefix: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(500).default(200),
}).superRefine((value, context) => {
  if (value.kind === 'iconify' && !ICON_ICONIFY_PREFIXES.includes(value.prefix as never)) {
    context.addIssue({ code: 'custom', path: ['prefix'], message: 'Unsupported Iconify prefix' })
  }
})

/** `seed` tops a collection up to its announced seed target; it never claims to be a full import. */
export const IconBulkImportSchema = z.object({
  prefix: z.enum(ICON_ICONIFY_PREFIXES),
  mode: z.enum(['full', 'missing', 'seed']).default('full'),
})

export const IconBulkStepSchema = z.object({
  batch: z.number().int().min(1).max(50).default(50),
})

export const IconSvgQuerySchema = z.object({
  size: z.coerce.number().int().min(8).max(512).default(24),
  stroke: z.coerce.number().min(0.5).max(4).default(2),
  color: z.string().max(32).regex(/^(currentColor|#[0-9a-fA-F]{3,8})$/).default('currentColor'),
})

export const IconImportItemMetaSchema = z.object({
  itemKey: z.string().min(1).max(300),
  filename: z.string().max(300).default(''),
})

export const IconBatchActions = ICON_BATCH_ACTIONS
export const IconSlug = Slug
