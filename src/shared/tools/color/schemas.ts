/**
 * Zod validation schemas for Color Assistant API requests and storage.
 */

import { z } from 'zod'

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
  id: z.string().optional(),
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
  id: z.string().optional(),
  title: z.string().min(1).max(100),
  colors: z.array(PaletteColorItemSchema).min(1).max(20),
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
  colors: z.array(PaletteColorItemSchema).min(1).max(20).optional(),
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
  source: z.enum(['studio', 'eyedropper', 'image', 'algorithm', 'ai']).default('studio'),
})

export const AiPaletteGenerateSchema = z.object({
  seedHex: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  style: z.string().max(100).optional(),
  tone: z.enum(['warm', 'cool', 'neutral', 'all']).default('all'),
  count: z.number().int().min(3).max(8).default(5),
  prompt: z.string().max(500).optional(),
})

export const AiPoeticInterpretSchema = z.object({
  colors: z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/)).min(1).max(12),
  theme: z.string().max(200).optional(),
})

export const UploadColorAssetSchema = z.object({
  assetType: z.enum(['image_card', 'palette_poster', 'gradient_export', 'ase']),
  fileFormat: z.enum(['png', 'jpg', 'svg', 'ase']),
  data: z.string(), // Base64 data URL or raw SVG text
  metadata: z.record(z.string(), z.unknown()).optional(),
})
