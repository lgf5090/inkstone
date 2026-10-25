import { z } from 'zod'

export const QrContentTypeSchema = z.enum([
  'text',
  'url',
  'wifi',
  'vcard',
  'email',
  'phone',
])

export const QrExportFormatSchema = z.enum([
  'png',
  'jpg',
  'jpeg',
  'svg',
  'webp',
])

export const QrErrorCorrectionSchema = z.enum(['L', 'M', 'Q', 'H'])

export const QrTemplateCategorySchema = z.enum([
  'minimal',
  'frame',
  'artistic',
  'scenario',
])

export const CreateQrRecordSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().max(200).default(''),
  contentType: QrContentTypeSchema.default('text'),
  contentRaw: z.string().min(1),
  optionsJson: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  fileType: QrExportFormatSchema.default('png'),
  fileData: z.string().optional(),
  fileSize: z.number().int().min(0).default(0),
  width: z.number().int().min(50).max(4000).default(1000),
  height: z.number().int().min(50).max(4000).default(1000),
})

export const QueryQrRecordsSchema = z.object({
  contentType: QrContentTypeSchema.optional(),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const CreateQrTemplateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  category: QrTemplateCategorySchema.default('minimal'),
  previewSvg: z.string().default(''),
  optionsJson: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sort: z.number().int().default(0),
})

export const UpdateQrTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  category: QrTemplateCategorySchema.optional(),
  previewSvg: z.string().optional(),
  optionsJson: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sort: z.number().int().optional(),
})

export const UpdateQrSettingsSchema = z.object({
  defaultErrorCorrection: QrErrorCorrectionSchema.optional(),
  defaultSize: z.number().int().min(100).max(4000).optional(),
  defaultFormat: QrExportFormatSchema.optional(),
  autoSaveHistory: z.boolean().optional(),
})

export const UploadLogoSchema = z.object({
  filename: z.string().trim().optional(),
  fileData: z.string().min(1),
  contentType: z.string().trim().optional(),
})
