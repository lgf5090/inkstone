import jsQR from 'jsqr'
import { organizerColorContrast } from '../../../../../shared/organizer-colors'
import type { QrStylingOptions } from '../../../../../shared/tools/qrcode/types'
import { resolveQuietZoneCells } from './qr-engine'
import { getQrModuleCount } from './qr-toolkit-engine'
import type { MessageKey } from '../../../../../shared/locales/en-US'

/** ECC levels restore roughly this fraction of codewords; a logo larger than it breaks the code. */
const ECC_TOLERANCE: Record<string, number> = { L: 0.07, M: 0.15, Q: 0.25, H: 0.3 }

/** WCAG contrast under this value is where QR readers start failing on coloured codes. */
export const MIN_CONTRAST_RATIO = 3
/** ISO/IEC 18004's recommended minimum quiet zone. */
export const RECOMMENDED_QUIET_CELLS = 4
/** A printed module smaller than this stops being resolvable by typical phone cameras. */
export const MIN_MODULE_MM = 0.4
const PRINT_DPI = 300

export interface ScannabilityReport {
  ecc: string
  modules: number
  version: number
  quietCells: number
  /** Null means the pair is not two plain colours, which is unknown rather than a pass. */
  contrastRatio: number | null
  logoAreaRatio: number
  eccTolerance: number
  modulePx: number
  moduleMm: number
  issues: MessageKey[]
}

/**
 * Measures the code the way a reader will meet it: the contrast it has to resolve, the white border
 * around it, how much of the symbol the logo covers relative to what the chosen error correction can
 * afford, and how big one module ends up at the export size and in print.
 */
export function assessScannability(
  options: QrStylingOptions,
  payload: string,
  exportSizePx: number
): ScannabilityReport {
  const ecc = options.errorCorrectionLevel || 'Q'
  const modules = getQrModuleCount(payload || ' ', ecc)
  const quietCells = resolveQuietZoneCells(options.margin)
  const background = options.backgroundOptions?.color || '#ffffff'

  // A gradient can hide an unreadable stop, so the weakest pair of stops is the one that counts.
  const dotColors = [
    options.dotsOptions?.color,
    ...(options.dotsOptions?.gradient?.colorStops?.map((stop) => stop.color) || []),
  ].filter((color): color is string => Boolean(color))
  const pairs = dotColors
    .map((color) => organizerColorContrast(color, background))
    .filter((ratio): ratio is number => ratio !== null)
  const contrastRatio = pairs.length ? Math.min(...pairs) : null

  const logoRatio = options.logoOptions?.size ?? options.imageOptions?.sizeRatio ?? 0
  const hasLogo = Boolean(
    options.logoOptions?.src || options.logoOptions?.url || options.logoOptions?.dataUrl || options.logoOptions?.logoId
  )
  const logoAreaRatio = hasLogo ? logoRatio * logoRatio : 0
  const eccTolerance = ECC_TOLERANCE[ecc] ?? 0.15

  const totalCells = modules + quietCells * 2
  const modulePx = exportSizePx > 0 ? exportSizePx / totalCells : 0
  const moduleMm = (modulePx / PRINT_DPI) * 25.4

  const issues: MessageKey[] = []
  if (contrastRatio !== null && contrastRatio < MIN_CONTRAST_RATIO) issues.push('tools.qrcode.check.low_contrast')
  if (quietCells < RECOMMENDED_QUIET_CELLS) issues.push('tools.qrcode.check.small_quiet_zone')
  if (logoAreaRatio > eccTolerance) issues.push('tools.qrcode.check.logo_too_large')
  if (moduleMm < MIN_MODULE_MM) issues.push('tools.qrcode.check.small_module')

  return {
    ecc,
    modules,
    version: Math.round((modules - 17) / 4),
    quietCells,
    contrastRatio,
    logoAreaRatio,
    eccTolerance,
    modulePx,
    moduleMm,
    issues,
  }
}

export type DecodeCheck = 'readable' | 'unreadable' | 'unknown'

/**
 * Decodes the rendered code with the same library the scanner uses. Returns 'unknown' rather than a
 * verdict when the pixel data cannot be read, so a surface never claims more than it measured.
 */
export function decodeRenderedCode(canvas: HTMLCanvasElement): DecodeCheck {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !canvas.width || !canvas.height) return 'unknown'
  try {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
    return code && code.data ? 'readable' : 'unreadable'
  } catch {
    return 'unknown'
  }
}
