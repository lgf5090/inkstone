import { z } from 'zod'
import type { QrStylingOptions } from './types'

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

/**
 * Colours reach canvas `fillStyle` and SVG attributes. Anything carrying a quote, an angle bracket or
 * a backslash would let a saved config close an attribute and write one of its own into the exported
 * SVG, so accepted shapes are listed rather than dangerous characters excluded.
 */
const COLOR = z
  .string()
  .trim()
  .regex(/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([0-9a-zA-Z.,% ]+\)|hsla?\([0-9a-zA-Z.,% ]+\))$/)

const FONT_FAMILY = z
  .string()
  .trim()
  .max(120)
  .regex(/^[a-zA-Z0-9 ,.'"-]+$/)

/** A logo is embedded or same-origin: a saved config must not make the reader fetch a third-party host. */
const LOGO_SRC = z
  .string()
  .max(4_000_000)
  .refine((v) => v.startsWith('data:image/') || v.startsWith('/') || v.startsWith('blob:'), {
    message: 'Logo source must be an embedded image or a same-origin path',
  })

const DOT_TYPE = z.enum([
  'square',
  'dots',
  'rounded',
  'classy',
  'classy-rounded',
  'extra-rounded',
  'diamonds',
])
const CORNER_SQUARE_TYPE = z.enum(['dot', 'square', 'extra-rounded'])
const CORNER_DOT_TYPE = z.enum(['dot', 'square'])
const EYE_SHAPE = z.enum([
  'square',
  'rounded',
  'circle',
  'leaf',
  'pointed',
  'leaf-diagonal',
  'leaf-pointed',
])
const FRAME_TYPE = z.enum([
  'none',
  'dark-green',
  'red-blue',
  'three-color',
  'heart',
  'liquid-stamp',
  'pacman',
  'meme-bubble',
  'mushroom',
])
const PIXEL_STYLE = z.enum(['square', 'rounded', 'dot', 'squircle', 'row', 'column'])
const MARKER_SHAPE = z.enum(['square', 'circle', 'plus', 'box', 'octagon', 'random', 'tiny-plus'])
const MARKER_INNER_SHAPE = z.enum(['auto', 'square', 'circle', 'plus', 'diamond', 'eye'])
const MARKER_SUB_SHAPE = z.enum(['square', 'circle', 'box', 'random', 'plus'])
const NOISE_SPACE = z.enum(['full', 'marker', 'minimal', 'extreme', 'none'])
const RENDER_POINTS = z.enum(['all', 'data', 'function', 'guide', 'marker'])
const CANVAS_EFFECT = z.enum(['none', 'crystalize', 'liquidify'])

const GRADIENT = z
  .object({
    type: z.enum(['linear', 'radial']),
    rotation: z.number().min(0).max(360).optional(),
    colorStops: z.array(z.object({ offset: z.number().min(0).max(1), color: COLOR })).min(1).max(8),
  })
  .strict()

const PAINT = (type: z.ZodTypeAny) =>
  z
    .object({
      type: type.optional(),
      color: COLOR.optional(),
      gradient: GRADIENT.optional(),
    })
    .strict()

const BACKGROUND = z
  .object({
    color: COLOR.optional(),
    gradient: GRADIENT.optional(),
  })
  .strict()

const LOGO = z
  .object({
    src: LOGO_SRC.optional(),
    url: LOGO_SRC.optional(),
    dataUrl: LOGO_SRC.optional(),
    logoId: z.string().trim().max(40).optional(),
    size: z.number().min(0).max(0.5).optional(),
    sizeRatio: z.number().min(0).max(0.5).optional(),
    margin: z.number().min(0).max(40).optional(),
    shape: z.enum(['original', 'rounded', 'circle']).optional(),
    shadow: z.boolean().optional(),
    hasShadow: z.boolean().optional(),
    hideBackgroundDots: z.boolean().optional(),
    clearBackground: z.boolean().optional(),
  })
  .strict()

const TEXT = z
  .object({
    enabled: z.boolean().optional(),
    content: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
    fontSize: z.number().min(8).max(200).optional(),
    fontFamily: FONT_FAMILY.optional(),
    color: COLOR.optional(),
    position: z.enum(['top', 'bottom']).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
  })
  .strict()

const FRAME = z
  .object({
    type: FRAME_TYPE.optional(),
    color: COLOR.optional(),
    secondaryColor: COLOR.optional(),
    text: z.string().max(60).optional(),
    label: z.string().max(60).optional(),
  })
  .strict()

const TOOLKIT = z
  .object({
    enabled: z.boolean().optional(),
    minVersion: z.number().int().min(1).max(40).optional(),
    maxVersion: z.number().int().min(1).max(40).optional(),
    maskPattern: z.number().int().min(-1).max(7).optional(),
    boostECC: z.boolean().optional(),
    seed: z.number().int().min(0).max(1_000_000_000).optional(),
    pixelStyle: PIXEL_STYLE.optional(),
    markerShape: MARKER_SHAPE.optional(),
    markerInnerShape: MARKER_INNER_SHAPE.optional(),
    markerSub: MARKER_SUB_SHAPE.optional(),
    markers: z
      .array(
        z
          .object({
            markerShape: MARKER_SHAPE,
            markerInnerShape: MARKER_INNER_SHAPE,
          })
          .strict()
      )
      .max(4)
      .optional(),
    marginNoise: z.boolean().optional(),
    marginNoiseRate: z.number().min(0).max(1).optional(),
    marginNoiseSpace: NOISE_SPACE.optional(),
    marginNoiseOpacity: z
      .union([z.number().min(0).max(1), z.array(z.number().min(0).max(1)).length(2)])
      .optional(),
    renderPointsType: RENDER_POINTS.optional(),
    rotate: z.number().int().min(0).max(360).optional(),
    invert: z.boolean().optional(),
    effect: CANVAS_EFFECT.optional(),
    effectTiming: z.enum(['before', 'after']).optional(),
    effectCrystalizeRadius: z.number().min(0).max(40).optional(),
    effectLiquidifyRadius: z.number().min(0).max(40).optional(),
    effectLiquidifyDistortRadius: z.number().min(0).max(40).optional(),
    effectLiquidifyThreshold: z.number().min(0).max(255).optional(),
    transformScale: z.number().min(0.2).max(3).optional(),
    transformPerspectiveX: z.number().min(-1).max(1).optional(),
    transformPerspectiveY: z.number().min(-1).max(1).optional(),
  })
  .strict()

/**
 * Styling as it arrives from an untrusted place: an imported file, a stored record, a saved template.
 * Every field is optional because these payloads are merged into the workbench rather than replacing
 * it whole, and unknown keys are refused so nothing outside the renderer's vocabulary survives.
 */
export const QrStylingOptionsSchema = z
  .object({
    width: z.number().min(1).max(4000).optional(),
    height: z.number().min(1).max(4000).optional(),
    // Quiet zone measured in modules, so an imported config cannot ask for a 100-cell margin.
    margin: z.number().int().min(0).max(16).optional(),
    errorCorrectionLevel: QrErrorCorrectionSchema.optional(),
    eyeShape: EYE_SHAPE.optional(),
    dotsOptions: PAINT(DOT_TYPE).optional(),
    cornersSquareOptions: PAINT(CORNER_SQUARE_TYPE).optional(),
    cornersDotOptions: PAINT(CORNER_DOT_TYPE).optional(),
    backgroundOptions: BACKGROUND.optional(),
    logoOptions: LOGO.optional(),
    imageOptions: LOGO.optional(),
    textOptions: TEXT.optional(),
    caption: TEXT.optional(),
    frameOptions: FRAME.optional(),
    toolkitOptions: TOOLKIT.optional(),
  })
  .strict()

export function parseQrStylingOptions(value: unknown): Partial<QrStylingOptions> | null {
  const parsed = QrStylingOptionsSchema.safeParse(value)
  return parsed.success ? (parsed.data as Partial<QrStylingOptions>) : null
}

export const CreateQrRecordSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().max(200).default(''),
  contentType: QrContentTypeSchema.default('text'),
  contentRaw: z.string().min(1).max(4096),
  optionsJson: z.string().max(200_000).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  fileType: QrExportFormatSchema.default('png'),
  fileData: z.string().max(20_000_000).optional(),
  fileSize: z.number().int().min(0).default(0),
  width: z.number().int().min(50).max(4000).default(1000),
  height: z.number().int().min(50).max(4000).default(1000),
})

export const QueryQrRecordsSchema = z.object({
  contentType: QrContentTypeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const CreateQrTemplateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  category: QrTemplateCategorySchema.default('minimal'),
  previewSvg: z.string().max(50_000).default(''),
  optionsJson: z.string().max(200_000).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sort: z.number().int().default(0),
})

export const UpdateQrTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  category: QrTemplateCategorySchema.optional(),
  previewSvg: z.string().max(50_000).optional(),
  optionsJson: z.string().max(200_000).optional(),
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
  filename: z.string().trim().max(120).optional(),
  fileData: z.string().min(1).max(20_000_000),
  contentType: z.string().trim().max(60).optional(),
})
