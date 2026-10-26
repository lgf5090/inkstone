import { describe, expect, it } from 'vitest'
import { BUILTIN_ID_PHOTO_SPECS, findSpecById } from '../src/shared/tools/id-photo/specs'
import { ID_PHOTO_BG_PRESETS, PRINT_SHEET_PRESETS } from '../src/shared/tools/id-photo/presets'
import { calculateOptimalCrop } from '../src/client/features/tools/id-photo/engine/face-align'
import { parseHexColor } from '../src/client/features/tools/id-photo/engine/background-matting'
import { calculatePrintLayout } from '../src/client/features/tools/id-photo/engine/print-layout-engine'
import { checkIdPhotoCompliance } from '../src/client/features/tools/id-photo/engine/compliance-engine'

describe('ID Photo Built-in Specifications & Presets', () => {
  it('contains comprehensive specifications with valid flag emojis and aspect ratios', () => {
    expect(BUILTIN_ID_PHOTO_SPECS.length).toBeGreaterThan(15)

    for (const spec of BUILTIN_ID_PHOTO_SPECS) {
      expect(spec.id).toBeTruthy()
      expect(spec.name).toBeTruthy()
      expect(spec.widthMm).toBeGreaterThan(0)
      expect(spec.heightMm).toBeGreaterThan(0)
      expect(spec.widthPx).toBeGreaterThan(0)
      expect(spec.heightPx).toBeGreaterThan(0)
      expect(spec.dpi).toBe(300)
      expect(spec.recommendedBgColors.length).toBeGreaterThan(0)

      // National standards should have flag emojis
      if (spec.category === 'cn_standard' || spec.category === 'intl_passport') {
        expect(spec.flagEmoji).toBeTruthy()
        expect(typeof spec.flagEmoji).toBe('string')
      }
    }
  })

  it('correctly retrieves specs by id', () => {
    const oneInch = findSpecById('cn_one_inch')
    expect(oneInch).toBeDefined()
    expect(oneInch?.widthMm).toBe(25)
    expect(oneInch?.heightMm).toBe(35)
    expect(oneInch?.flagEmoji).toBe('🇨🇳')

    const usPassport = findSpecById('intl_us_passport')
    expect(usPassport).toBeDefined()
    expect(usPassport?.widthMm).toBe(51)
    expect(usPassport?.heightMm).toBe(51)
    expect(usPassport?.flagEmoji).toBe('🇺🇸')
  })

  it('provides predefined background presets and print sheet presets', () => {
    expect(ID_PHOTO_BG_PRESETS.length).toBeGreaterThanOrEqual(8)
    const whitePreset = ID_PHOTO_BG_PRESETS.find((p) => p.id === 'pure_white')
    expect(whitePreset?.color).toBe('#ffffff')

    expect(PRINT_SHEET_PRESETS.length).toBe(3)
    const sheet6Inch = PRINT_SHEET_PRESETS.find((p) => p.id === '6inch')
    expect(sheet6Inch?.widthMm).toBe(102)
    expect(sheet6Inch?.heightMm).toBe(152)
  })
})

describe('Face Alignment & Intelligent Cropping', () => {
  it('computes center crop when no face box is supplied', () => {
    const crop = calculateOptimalCrop(1000, 1000, 295, 413)
    expect(crop.targetWidth).toBe(295)
    expect(crop.targetHeight).toBe(413)
    expect(crop.cropWidth).toBeLessThanOrEqual(1000)
    expect(crop.cropHeight).toBe(1000)
    expect(crop.cropX).toBeGreaterThan(0)
    expect(crop.cropY).toBe(0)
  })

  it('aligns to face bounding box respecting head ratio constraints', () => {
    const faceBox = { x: 300, y: 200, width: 200, height: 260 }
    const crop = calculateOptimalCrop(1200, 1600, 295, 413, faceBox, 0.72)

    expect(crop.cropX).toBeGreaterThanOrEqual(0)
    expect(crop.cropY).toBeGreaterThanOrEqual(0)
    expect(crop.cropX + crop.cropWidth).toBeLessThanOrEqual(1200)
    expect(crop.cropY + crop.cropHeight).toBeLessThanOrEqual(1600)
  })
})

describe('Color & Hex Utilities', () => {
  it('parses 3-character and 6-character hex colors accurately', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHexColor('#000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseHexColor('#438EDB')).toEqual({ r: 0x43, g: 0x8e, b: 0xdb })
    expect(parseHexColor('invalid')).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('Print Layout Engine', () => {
  it('calculates optimal grid layout for 1-inch photos on 6-inch paper', () => {
    const layout = calculatePrintLayout(25, 35, {
      paperSize: '6inch',
      orientation: 'portrait',
      gapMm: 2,
      marginMm: 5,
      showCropMarks: true,
      dpi: 300,
    })

    expect(layout.cols).toBeGreaterThanOrEqual(3)
    expect(layout.rows).toBeGreaterThanOrEqual(3)
    expect(layout.totalCount).toBeGreaterThanOrEqual(8)
    expect(layout.startX).toBeGreaterThan(0)
    expect(layout.startY).toBeGreaterThan(0)
  })

  it('calculates print layout for 2-inch photos on 5-inch paper', () => {
    const layout = calculatePrintLayout(35, 49, {
      paperSize: '5inch',
      orientation: 'landscape',
      gapMm: 3,
      marginMm: 4,
      showCropMarks: true,
      dpi: 300,
    })

    expect(layout.totalCount).toBeGreaterThanOrEqual(2)
  })
})

describe('ID Photo Compliance Analyzer', () => {
  const spec = BUILTIN_ID_PHOTO_SPECS.find((s) => s.id === 'cn_one_inch')!

  it('scores 100 for perfectly compliant photo', () => {
    const report = checkIdPhotoCompliance({
      spec,
      actualWidthPx: 295,
      actualHeightPx: 413,
      fileSizeBytes: 80 * 1024,
      faceBox: { x: 47, y: 80, width: 200, height: 235 }, // head ~ 71% of 413
      bgColorHex: '#ffffff',
    })

    expect(report.passed).toBe(true)
    expect(report.score).toBe(100)
    expect(report.checks.every((c) => c.passed)).toBe(true)
  })

  it('detects dimension mismatches and deducts score', () => {
    const report = checkIdPhotoCompliance({
      spec,
      actualWidthPx: 400,
      actualHeightPx: 400, // 1:1 instead of 5:7
      bgColorHex: '#ffffff',
    })

    expect(report.passed).toBe(false)
    expect(report.score).toBeLessThan(80)
    const dimCheck = report.checks.find((c) => c.id === 'dimensions')
    expect(dimCheck?.passed).toBe(false)
  })

  it('warns when file size exceeds official standard limit', () => {
    const examSpec = BUILTIN_ID_PHOTO_SPECS.find((s) => s.id === 'exam_postgraduate')!
    const report = checkIdPhotoCompliance({
      spec: examSpec,
      actualWidthPx: 480,
      actualHeightPx: 640,
      fileSizeBytes: 250 * 1024, // 250KB exceeds 100KB limit
    })

    const sizeCheck = report.checks.find((c) => c.id === 'file_size')
    expect(sizeCheck?.passed).toBe(false)
    expect(sizeCheck?.level).toBe('fail')
  })
})
