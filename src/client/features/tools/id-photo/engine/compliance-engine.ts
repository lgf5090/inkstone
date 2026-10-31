import type { IdPhotoComplianceReport, IdPhotoSpec } from '@shared/tools/id-photo/types'
import { calculateOptimalCrop } from './face-align'

export interface ComplianceInput {
  spec: IdPhotoSpec
  actualWidthPx: number
  actualHeightPx: number
  fileSizeBytes?: number
  sourceWidthPx?: number
  sourceHeightPx?: number
  faceBox?: { x: number; y: number; width: number; height: number }
  bgColorHex?: string
}

const UPSCALE_TOLERANCE = 1.02
const HEAD_CROWN_FACTOR = 1.25
const CENTER_OFFSET_LIMIT = 0.05
const ASPECT_TOLERANCE = 0.02
const DEDUCT_DIMENSIONS = 25
const DEDUCT_FILE_SIZE = 20
const DEDUCT_FILE_SIZE_MIN = 10
const DEDUCT_FACE_RATIO = 20
const DEDUCT_CENTERING = 15
const DEDUCT_BG_COLOR = 15
const DEDUCT_UPSCALE = 10
const PASS_THRESHOLD = 80

type Check = IdPhotoComplianceReport['checks'][number]

export function effectiveUpscale(
  sourceWidthPx: number,
  sourceHeightPx: number,
  targetWidthPx: number,
  targetHeightPx: number,
): number {
  const crop = calculateOptimalCrop(sourceWidthPx, sourceHeightPx, targetWidthPx, targetHeightPx)
  if (!crop.cropWidth) return 1
  return targetWidthPx / crop.cropWidth
}

export function checkIdPhotoCompliance(input: ComplianceInput): IdPhotoComplianceReport {
  const { spec, actualWidthPx, actualHeightPx, fileSizeBytes, sourceWidthPx, sourceHeightPx, faceBox, bgColorHex } =
    input

  const checks: Check[] = []
  let score = 100
  const unknown = (id: string, titleKey: string, expectedValue: string): void => {
    checks.push({ id, titleKey, passed: false, level: 'unknown', message: '', expectedValue })
  }

  const expectedAspect = spec.widthPx / spec.heightPx
  const actualAspect = actualWidthPx / actualHeightPx
  const aspectDiff = Math.abs(expectedAspect - actualAspect)
  const pixels = `${actualWidthPx}×${actualHeightPx}`

  if (actualWidthPx === spec.widthPx && actualHeightPx === spec.heightPx) {
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: true,
      level: 'pass',
      message: pixels,
      currentValue: pixels,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  } else if (aspectDiff < ASPECT_TOLERANCE) {
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: true,
      level: 'pass',
      message: pixels,
      currentValue: pixels,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  } else {
    score -= DEDUCT_DIMENSIONS
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: false,
      level: 'fail',
      message: pixels,
      currentValue: pixels,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  }

  if (fileSizeBytes === undefined) {
    unknown('file_size', 'tools.id_photo.compliance.check_file_size', `${spec.fileSizeMaxKb ?? '—'} KB`)
  } else {
    const sizeKb = Math.round(fileSizeBytes / 1024)
    if (spec.fileSizeMaxKb && sizeKb > spec.fileSizeMaxKb) {
      score -= DEDUCT_FILE_SIZE
      checks.push({
        id: 'file_size',
        titleKey: 'tools.id_photo.compliance.check_file_size',
        passed: false,
        level: 'fail',
        message: `${sizeKb} KB`,
        currentValue: `${sizeKb} KB`,
        expectedValue: `≤ ${spec.fileSizeMaxKb} KB`,
      })
    } else if (spec.fileSizeMinKb && sizeKb < spec.fileSizeMinKb) {
      score -= DEDUCT_FILE_SIZE_MIN
      checks.push({
        id: 'file_size',
        titleKey: 'tools.id_photo.compliance.check_file_size',
        passed: false,
        level: 'warning',
        message: `${sizeKb} KB`,
        currentValue: `${sizeKb} KB`,
        expectedValue: `≥ ${spec.fileSizeMinKb} KB`,
      })
    } else {
      checks.push({
        id: 'file_size',
        titleKey: 'tools.id_photo.compliance.check_file_size',
        passed: true,
        level: 'pass',
        message: `${sizeKb} KB`,
        currentValue: `${sizeKb} KB`,
        expectedValue: spec.fileSizeMaxKb ? `≤ ${spec.fileSizeMaxKb} KB` : `${sizeKb} KB`,
      })
    }
  }

  if (!sourceWidthPx || !sourceHeightPx) {
    unknown('source_scale', 'tools.id_photo.compliance.check_source_scale', `${spec.widthPx}×${spec.heightPx} px`)
  } else {
    const scale = effectiveUpscale(sourceWidthPx, sourceHeightPx, spec.widthPx, spec.heightPx)
    if (scale > UPSCALE_TOLERANCE) {
      score -= DEDUCT_UPSCALE
      checks.push({
        id: 'source_scale',
        titleKey: 'tools.id_photo.compliance.check_source_scale',
        passed: false,
        level: 'warning',
        message: `×${scale.toFixed(2)}`,
        currentValue: `×${scale.toFixed(2)}`,
        expectedValue: `≤ ×${UPSCALE_TOLERANCE.toFixed(2)}`,
      })
    } else {
      checks.push({
        id: 'source_scale',
        titleKey: 'tools.id_photo.compliance.check_source_scale',
        passed: true,
        level: 'pass',
        message: `×${scale.toFixed(2)}`,
        currentValue: `×${scale.toFixed(2)}`,
        expectedValue: `≤ ×${UPSCALE_TOLERANCE.toFixed(2)}`,
      })
    }
  }

  if (!faceBox) {
    unknown('face_ratio', 'tools.id_photo.compliance.check_face_ratio', `${Math.round(spec.faceRatioMin * 100)}% – ${Math.round(spec.faceRatioMax * 100)}%`)
    unknown('face_centering', 'tools.id_photo.compliance.check_centering', `${Math.round(CENTER_OFFSET_LIMIT * 100)}%`)
  } else {
    const headRatio = (faceBox.height * HEAD_CROWN_FACTOR) / actualHeightPx
    const percent = `${Math.round(headRatio * 100)}%`
    if (headRatio >= spec.faceRatioMin && headRatio <= spec.faceRatioMax) {
      checks.push({
        id: 'face_ratio',
        titleKey: 'tools.id_photo.compliance.check_face_ratio',
        passed: true,
        level: 'pass',
        message: percent,
        currentValue: percent,
        expectedValue: `${Math.round(spec.faceRatioMin * 100)}% – ${Math.round(spec.faceRatioMax * 100)}%`,
      })
    } else {
      score -= DEDUCT_FACE_RATIO
      checks.push({
        id: 'face_ratio',
        titleKey: 'tools.id_photo.compliance.check_face_ratio',
        passed: false,
        level: headRatio < spec.faceRatioMin ? 'fail' : 'warning',
        message: percent,
        currentValue: percent,
        expectedValue: `${Math.round(spec.faceRatioMin * 100)}% – ${Math.round(spec.faceRatioMax * 100)}%`,
      })
    }

    const centerOffset = Math.abs(faceBox.x + faceBox.width / 2 - actualWidthPx / 2) / actualWidthPx
    if (centerOffset <= CENTER_OFFSET_LIMIT) {
      checks.push({
        id: 'face_centering',
        titleKey: 'tools.id_photo.compliance.check_centering',
        passed: true,
        level: 'pass',
        message: `${Math.round(centerOffset * 100)}%`,
        currentValue: `${Math.round(centerOffset * 100)}%`,
        expectedValue: `≤ ${Math.round(CENTER_OFFSET_LIMIT * 100)}%`,
      })
    } else {
      score -= DEDUCT_CENTERING
      checks.push({
        id: 'face_centering',
        titleKey: 'tools.id_photo.compliance.check_centering',
        passed: false,
        level: 'warning',
        message: `${Math.round(centerOffset * 100)}%`,
        currentValue: `${Math.round(centerOffset * 100)}%`,
        expectedValue: `≤ ${Math.round(CENTER_OFFSET_LIMIT * 100)}%`,
      })
    }
  }

  if (!bgColorHex || spec.recommendedBgColors.length === 0) {
    unknown('bg_color', 'tools.id_photo.compliance.check_bg_color', spec.recommendedBgColors.join(' / ') || '—')
  } else {
    const isRecommended = spec.recommendedBgColors.some(
      (color) => color.toLowerCase() === bgColorHex.toLowerCase(),
    )
    checks.push({
      id: 'bg_color',
      titleKey: 'tools.id_photo.compliance.check_bg_color',
      passed: isRecommended,
      level: isRecommended ? 'pass' : 'warning',
      message: bgColorHex,
      currentValue: bgColorHex,
      expectedValue: spec.recommendedBgColors.join(' / '),
    })
    if (!isRecommended) score -= DEDUCT_BG_COLOR
  }

  const finalScore = Math.max(0, Math.min(100, score))
  return {
    score: finalScore,
    passed: finalScore >= PASS_THRESHOLD,
    checks,
  }
}
