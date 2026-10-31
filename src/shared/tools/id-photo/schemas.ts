import { z } from 'zod'

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const HexColor = z.string().regex(HEX_COLOR)

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
  nameKey: z.string().optional(),
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
  printPaperSize: z.enum(['5inch', '6inch', 'a4']).optional(),
})

export const UpdateCustomSpecSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  isFavorite: z.boolean().optional(),
})

const optionalRange = (min: number, max: number) => z.number().min(min).max(max).optional()

export const IdPhotoAdjustOptionsSchema = z.object({
  specId: z.string().min(1).max(60),
  bgColor: HexColor,
  bgType: z.enum(['solid', 'gradient']),
  bgGradientEndColor: HexColor.optional(),
  feathering: optionalRange(0, 100),
  brightness: optionalRange(-100, 100),
  contrast: optionalRange(-100, 100),
  smoothness: optionalRange(0, 100),
  whitening: optionalRange(0, 100),
  sharpness: optionalRange(0, 100),
  attireId: z.string().max(60).optional(),
  attireScale: optionalRange(0.5, 2),
  attireOffsetX: optionalRange(-500, 500),
  attireOffsetY: optionalRange(-500, 500),
  cropX: optionalRange(0, 20000),
  cropY: optionalRange(0, 20000),
  cropWidth: optionalRange(1, 20000),
  cropHeight: optionalRange(1, 20000),
  rotation: optionalRange(-360, 360),
})
