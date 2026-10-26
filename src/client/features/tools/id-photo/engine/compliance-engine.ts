import type { IdPhotoComplianceReport, IdPhotoSpec } from '@shared/tools/id-photo/types'

export interface ComplianceInput {
  spec: IdPhotoSpec
  actualWidthPx: number
  actualHeightPx: number
  fileSizeBytes?: number
  faceBox?: { x: number; y: number; width: number; height: number }
  bgColorHex?: string
}

export function checkIdPhotoCompliance(input: ComplianceInput): IdPhotoComplianceReport {
  const { spec, actualWidthPx, actualHeightPx, fileSizeBytes, faceBox, bgColorHex } = input

  const checks: IdPhotoComplianceReport['checks'] = []
  let score = 100

  // 1. Resolution & Dimension check
  const expectedAspect = spec.widthPx / spec.heightPx
  const actualAspect = actualWidthPx / actualHeightPx
  const aspectDiff = Math.abs(expectedAspect - actualAspect)

  if (actualWidthPx === spec.widthPx && actualHeightPx === spec.heightPx) {
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: true,
      level: 'pass',
      message: `${actualWidthPx}×${actualHeightPx} px (100% matched)`,
      currentValue: `${actualWidthPx}×${actualHeightPx}`,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  } else if (aspectDiff < 0.02) {
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: true,
      level: 'pass',
      message: `Aspect ratio matched (${actualWidthPx}×${actualHeightPx} px)`,
      currentValue: `${actualWidthPx}×${actualHeightPx}`,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  } else {
    score -= 25
    checks.push({
      id: 'dimensions',
      titleKey: 'tools.id_photo.compliance.check_dimensions',
      passed: false,
      level: 'fail',
      message: `Dimension aspect ratio mismatch (${actualWidthPx}×${actualHeightPx} px)`,
      currentValue: `${actualWidthPx}×${actualHeightPx}`,
      expectedValue: `${spec.widthPx}×${spec.heightPx}`,
    })
  }

  // 2. File size constraint check (if specified by standard)
  if (fileSizeBytes !== undefined && spec.fileSizeMaxKb) {
    const sizeKb = Math.round(fileSizeBytes / 1024)
    if (sizeKb <= spec.fileSizeMaxKb) {
      if (spec.fileSizeMinKb && sizeKb < spec.fileSizeMinKb) {
        score -= 10
        checks.push({
          id: 'file_size',
          titleKey: 'tools.id_photo.compliance.check_file_size',
          passed: false,
          level: 'warning',
          message: `${sizeKb} KB is below recommended minimum (${spec.fileSizeMinKb} KB)`,
          currentValue: `${sizeKb} KB`,
          expectedValue: `≥ ${spec.fileSizeMinKb} KB`,
        })
      } else {
        checks.push({
          id: 'file_size',
          titleKey: 'tools.id_photo.compliance.check_file_size',
          passed: true,
          level: 'pass',
          message: `${sizeKb} KB is within limit (< ${spec.fileSizeMaxKb} KB)`,
          currentValue: `${sizeKb} KB`,
          expectedValue: `≤ ${spec.fileSizeMaxKb} KB`,
        })
      }
    } else {
      score -= 20
      checks.push({
        id: 'file_size',
        titleKey: 'tools.id_photo.compliance.check_file_size',
        passed: false,
        level: 'fail',
        message: `${sizeKb} KB exceeds maximum allowed size (${spec.fileSizeMaxKb} KB)`,
        currentValue: `${sizeKb} KB`,
        expectedValue: `≤ ${spec.fileSizeMaxKb} KB`,
      })
    }
  }

  // 3. Head & Face Proportion check
  if (faceBox) {
    const estimatedHeadHeight = faceBox.height * 1.25
    const headRatio = estimatedHeadHeight / actualHeightPx

    if (headRatio >= spec.faceRatioMin && headRatio <= spec.faceRatioMax) {
      checks.push({
        id: 'face_ratio',
        titleKey: 'tools.id_photo.compliance.check_face_ratio',
        passed: true,
        level: 'pass',
        message: `Head occupies ${Math.round(headRatio * 100)}% of frame`,
        currentValue: `${Math.round(headRatio * 100)}%`,
        expectedValue: `${Math.round(spec.faceRatioMin * 100)}% - ${Math.round(spec.faceRatioMax * 100)}%`,
      })
    } else {
      score -= 20
      const isTooSmall = headRatio < spec.faceRatioMin
      checks.push({
        id: 'face_ratio',
        titleKey: 'tools.id_photo.compliance.check_face_ratio',
        passed: false,
        level: isTooSmall ? 'fail' : 'warning',
        message: isTooSmall
          ? `Head proportion ${Math.round(headRatio * 100)}% is too small, zoom in`
          : `Head proportion ${Math.round(headRatio * 100)}% is too large, zoom out`,
        currentValue: `${Math.round(headRatio * 100)}%`,
        expectedValue: `${Math.round(spec.faceRatioMin * 100)}% - ${Math.round(spec.faceRatioMax * 100)}%`,
      })
    }

    // 4. Face horizontal centering check
    const faceCenterX = faceBox.x + faceBox.width / 2
    const imageCenterX = actualWidthPx / 2
    const centerOffset = Math.abs(faceCenterX - imageCenterX) / actualWidthPx

    if (centerOffset <= 0.05) {
      checks.push({
        id: 'face_centering',
        titleKey: 'tools.id_photo.compliance.check_centering',
        passed: true,
        level: 'pass',
        message: 'Face horizontally centered',
      })
    } else {
      score -= 15
      checks.push({
        id: 'face_centering',
        titleKey: 'tools.id_photo.compliance.check_centering',
        passed: false,
        level: 'warning',
        message: 'Face offset from horizontal center',
      })
    }
  }

  // 5. Background color check
  if (bgColorHex && spec.recommendedBgColors.length > 0) {
    const isRecommended = spec.recommendedBgColors.some(
      (c) => c.toLowerCase() === bgColorHex.toLowerCase()
    )
    if (isRecommended) {
      checks.push({
        id: 'bg_color',
        titleKey: 'tools.id_photo.compliance.check_bg_color',
        passed: true,
        level: 'pass',
        message: 'Background color matches standard recommendation',
      })
    } else {
      score -= 15
      checks.push({
        id: 'bg_color',
        titleKey: 'tools.id_photo.compliance.check_bg_color',
        passed: false,
        level: 'warning',
        message: 'Background color differs from standard guidelines',
      })
    }
  }

  const finalScore = Math.max(0, Math.min(100, score))
  return {
    score: finalScore,
    passed: finalScore >= 80,
    checks,
  }
}
