import { z } from 'zod'

export const IdPhotoCategorySchema = z.enum([
  'cn_standard',
  'exam_cert',
  'intl_passport',
  'visa',
  'custom',
])

export const IdPhotoSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: IdPhotoCategorySchema,
  countryCode: z.string().default(''),
  countryNameKey: z.string().default(''),
  flagEmoji: z.string().optional(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  dpi: z.number().int().default(300),
  recommendedBgColors: z.array(z.string()).default(['#ffffff']),
  faceRatioMin: z.number().min(0).max(1).default(0.6),
  faceRatioMax: z.number().min(0).max(1).default(0.8),
  fileSizeMinKb: z.number().optional(),
  fileSizeMaxKb: z.number().optional(),
  aspectRatioLabel: z.string().optional(),
  descriptionKey: z.string().optional(),
  isBuiltin: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
})

export const CreateIdPhotoRecordSchema = z.object({
  title: z.string().default(''),
  specId: z.string().min(1),
  specName: z.string().default(''),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  widthMm: z.number().nonnegative().default(0),
  heightMm: z.number().nonnegative().default(0),
  dpi: z.number().int().default(300),
  bgColor: z.string().default('#ffffff'),
  options: z.record(z.string(), z.unknown()).default({}),
  fileData: z.string().min(1), // base64 / data-url
  printFileData: z.string().optional(),
  fileType: z.enum(['jpg', 'jpeg', 'png', 'webp']).default('jpg'),
})

export const QueryIdPhotoRecordsSchema = z.object({
  specId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
})

export const CreateCustomSpecSchema = z.object({
  name: z.string().min(1).max(50),
  category: IdPhotoCategorySchema.default('custom'),
  countryCode: z.string().max(10).default(''),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  dpi: z.number().int().default(300),
  recommendedBgColors: z.array(z.string()).default(['#ffffff']),
  faceRatioMin: z.number().min(0).max(1).default(0.6),
  faceRatioMax: z.number().min(0).max(1).default(0.8),
  fileSizeMaxKb: z.number().int().optional(),
})

export const UpdateIdPhotoSettingsSchema = z.object({
  defaultSpecId: z.string().optional(),
  defaultBgColor: z.string().optional(),
  defaultDpi: z.number().int().positive().optional(),
  defaultExportFormat: z.enum(['jpg', 'jpeg', 'png', 'webp']).optional(),
  autoSaveHistory: z.boolean().optional(),
  autoFaceAlign: z.boolean().optional(),
  printPaperSize: z.enum(['5inch', '6inch', 'a4']).optional(),
})
