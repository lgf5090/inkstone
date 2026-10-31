/**
 * Zod validation schemas for Color Assistant API requests and storage.
 */

import { z } from 'zod'
import {
  COLOR_AI_INTERPRET_MAX,
  COLOR_AI_PALETTE_MAX,
  COLOR_AI_PALETTE_MIN,
  COLOR_ASSET_MAX_ENCODED_CHARS,
  COLOR_HISTORY_SOURCES,
  COLOR_PALETTE_MAX_COLORS,
} from './contract'

/**
 * Client-supplied row ids are optional, but they are also primary keys: an unbounded string here is an
 * unbounded string in the index, and a duplicate answers as a constraint violation rather than a conflict.
 */
const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{3,39}$/i, 'Must be 4-40 letters, digits, _ or -')

export const RgbColorSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
  a: z.number().min(0).max(1).optional(),
})

export const CmykColorSchema = z.object({
  c: z.number().min(0).max(100),
  m: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  k: z.number().min(0).max(100),
})

export const LabColorSchema = z.object({
  l: z.number(),
  a: z.number(),
  b: z.number(),
})

export const CreateColorFavoriteSchema = z.object({
  id: AssetIdSchema.optional(),
  name: z.string().max(100).default(''),
  hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color'),
  rgb: RgbColorSchema.optional(),
  cmyk: CmykColorSchema.optional(),
  lab: LabColorSchema.optional(),
  tags: z.array(z.string().max(50)).default([]),
  note: z.string().max(500).default(''),
  sort: z.number().int().default(0),
})

export const UpdateColorFavoriteSchema = z.object({
  name: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).optional(),
  note: z.string().max(500).optional(),
  sort: z.number().int().optional(),
})

export const PaletteColorItemSchema = z.object({
  hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/),
  name: z.string().max(100).optional(),
  ratio: z.number().min(0).max(100).optional(),
})

export const CreateColorPaletteSchema = z.object({
  id: AssetIdSchema.optional(),
  title: z.string().min(1).max(100),
  colors: z.array(PaletteColorItemSchema).min(1).max(COLOR_PALETTE_MAX_COLORS),
  sourceType: z
    .enum(['custom', 'colorhunt', 'mycolorspace', 'ai', 'image', 'harmony'])
    .default('custom'),
  description: z.string().max(1000).default(''),
  tags: z.array(z.string().max(50)).default([]),
  likesCount: z.number().int().min(0).default(0),
  previewSvg: z.string().max(50000).default(''),
  isFavorite: z.boolean().default(true),
  sort: z.number().int().default(0),
})

export const UpdateColorPaletteSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  colors: z.array(PaletteColorItemSchema).min(1).max(COLOR_PALETTE_MAX_COLORS).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).optional(),
  likesCount: z.number().int().min(0).optional(),
  previewSvg: z.string().max(50000).optional(),
  isFavorite: z.boolean().optional(),
  sort: z.number().int().optional(),
})

export const UpdateColorSettingsSchema = z.object({
  stripHash: z.boolean().optional(),
  defaultFormat: z.enum(['hex', 'rgb', 'hsl', 'cmyk', 'lab']).optional(),
  defaultUiTab: z.string().max(50).optional(),
  autoSaveHistory: z.boolean().optional(),
})

export const AddColorHistorySchema = z.object({
  hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/),
  source: z.enum(COLOR_HISTORY_SOURCES).default('studio'),
})

export const AiPaletteGenerateSchema = z.object({
  seedHex: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  style: z.string().max(100).optional(),
  tone: z.enum(['warm', 'cool', 'neutral', 'all']).default('all'),
  count: z.number().int().min(COLOR_AI_PALETTE_MIN).max(COLOR_AI_PALETTE_MAX).default(5),
  prompt: z.string().max(500).optional(),
})

export const AiPoeticInterpretSchema = z.object({
  colors: z
    .array(z.string().regex(/^#?[0-9a-fA-F]{6}$/))
    .min(1)
    .max(COLOR_AI_INTERPRET_MAX),
  theme: z.string().max(200).optional(),
})

/** Metadata is stored as JSON and echoed back by the asset route; flat scalars only, and few of them. */
const AssetMetadataSchema = z
  .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 12, 'Metadata may carry at most 12 fields')

export const UploadColorAssetSchema = z.object({
  assetType: z.enum(['image_card', 'palette_poster', 'gradient_export', 'ase']),
  // The format is the only thing that decides the served Content-Type: a client that could name the MIME
  // could hand back `text/html` from the application's own origin.
  fileFormat: z.enum(['png', 'jpg', 'svg', 'ase']),
  data: z.string().min(1).max(COLOR_ASSET_MAX_ENCODED_CHARS),
  metadata: AssetMetadataSchema.optional(),
})
